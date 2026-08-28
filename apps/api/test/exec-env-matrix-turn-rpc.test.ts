import {
    MF_RUNTIME_IDENTITY_ENV_KEYS,
    frameworkCapabilities
} from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    execEnvSurface,
    execEnvSurfaceKey,
    execEnvSurfaces,
    type ExecEnvSurface,
    type ExecTransport
} from './exec-env-contract'
import {
    adapterCtx,
    buildAdapter,
    createSeam,
    drain,
    resumeCtx,
    stubGatewayResolution,
    withEnv,
    withGatewayFetch,
    EXTRAS_MARKERS,
    USER_MESSAGE,
    type Seam
} from './exec-env-harness'

// The service-framework half of the matrix. Separate file because these cells
// are reached by toggling process-level flags, which must not race the driver
// seam cells running alongside them.

const RUNNER_DAEMON_ID = 'dh_runner'

// Everything a cell needs open to be reachable, derived from its declared
// gates. The contract states the gates; opening them here is what proves the
// declaration corresponds to a transport that actually exists.
const gateEnv = (surface: ExecEnvSurface): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const gate of surface.gatedBy ?? []) {
        if (gate.startsWith('daemon:')) continue
        if (gate === 'MF_SPRITE_RUNNER_AGENTS') continue
        env[gate] = '1'
    }
    return env
}

const daemonFeatures = (surface: ExecEnvSurface): string[] =>
    (surface.gatedBy ?? [])
        .filter((gate) => gate.startsWith('daemon:'))
        .map((gate) => gate.slice('daemon:'.length))

// A runner-carried sprite turn is the only way a sprite reaches a daemon
// transport; a BYOD daemon agent is already on one.
const carriesRunner = (surface: ExecEnvSurface): boolean =>
    surface.runtime === 'sprites' && surface.transport === 'turn-rpc'

const dispatch = async (
    surface: ExecEnvSurface,
    opts: { features?: string[]; flags?: Record<string, string> } = {}
): Promise<Seam> => {
    const seam = createSeam()
    const adapter = buildAdapter(seam, {
        framework: surface.framework,
        runtime: surface.runtime,
        clientFeatures: opts.features ?? daemonFeatures(surface)
    })
    stubGatewayResolution(adapter)
    await withEnv(opts.flags ?? gateEnv(surface), async () => {
        await withGatewayFetch(seam, async () => {
            await drain(
                adapter.sendMessage(
                    adapterCtx(surface.framework, surface.runtime, {
                        ...(carriesRunner(surface)
                            ? { runnerDaemonId: RUNNER_DAEMON_ID }
                            : {})
                    } as never),
                    USER_MESSAGE
                )
            )
        })
    })
    return seam
}

const rpcOf = (seam: Seam, method: string): Record<string, unknown> => {
    const call = seam.rpcs.find((rpc) => rpc.method === method)
    assert.ok(
        call,
        `expected a ${method} RPC, saw ${seam.rpcs.map((r) => r.method).join(', ') || 'none'}`
    )
    return call.payload
}

// The env keys a payload-carrying transport must dispatch: the cell's own
// platform keys, plus the agent extras when the row declares them per-exec —
// derived from the declared groups so the rows stay declarative.
const expectedPayloadEnvKeys = (surface: ExecEnvSurface): string[] =>
    [
        ...(surface.payloadEnvKeys ?? []),
        ...(surface.extras === 'per-exec' ? Object.keys(EXTRAS_MARKERS) : [])
    ].sort()

for (const surface of execEnvSurfaces.filter(
    (s) => s.transport === 'turn-rpc'
)) {
    const key = execEnvSurfaceKey(surface)

    test(`${key} reaches turn.start when its declared gates are open`, async () => {
        const seam = await dispatch(surface)
        const call = seam.rpcs.find((rpc) => rpc.method === 'turn.start')
        assert.ok(call, `${key}: no turn.start dispatched with the gates open`)
        assert.equal(
            call.refIdOverride,
            'msg_marker',
            `${key}: the turn must pin an exec ref so a resume can find it`
        )
        assert.equal(
            seam.gatewayCalls.length,
            0,
            `${key}: must not also call the gateway`
        )
    })

    test(`${key} carries exactly the declared payload env`, async () => {
        const payload = rpcOf(await dispatch(surface), 'turn.start')
        const env = (payload.env ?? {}) as Record<string, string>
        assert.deepEqual(
            Object.keys(env).sort(),
            expectedPayloadEnvKeys(surface),
            `${key}: turn.start payload env does not match the contract`
        )
        for (const name of MF_RUNTIME_IDENTITY_ENV_KEYS)
            assert.equal(
                name in env,
                false,
                `${key}: identity is declared ${surface.identity}, but ${name} rode the payload`
            )
    })

    test(`${key} falls back to the gateway when a gate is closed`, async () => {
        // Each declared flag is load-bearing on its own: closing any one of
        // them must take the cell off the daemon transport rather than half
        // enable it.
        for (const flag of Object.keys(gateEnv(surface))) {
            const seam = await dispatch(surface, {
                flags: { ...gateEnv(surface), [flag]: '' }
            })
            assert.equal(
                seam.rpcs.filter((rpc) => rpc.method === 'turn.start').length,
                0,
                `${key}: ${flag} off must not reach turn.start`
            )
        }
    })

    if (surface.capabilityCheckedAt !== 'resolution')
        test(`${key} never dispatches turn.start when the daemon does not advertise the capability`, async () => {
            const seam = await dispatch(surface, { features: [] })
            assert.equal(
                seam.rpcs.filter((rpc) => rpc.method === 'turn.start').length,
                0,
                `${key}: a daemon that never advertised the feature must not be sent turn.start`
            )
        })

    if (surface.resume === 'attach-no-env')
        test(`${key} resumes by re-attaching, carrying no env`, async () => {
            const seam = createSeam()
            const adapter = buildAdapter(seam, {
                framework: surface.framework,
                runtime: surface.runtime,
                clientFeatures: daemonFeatures(surface)
            })
            assert.ok(adapter.resumeMessage, `${key}: declared resumable`)
            await withEnv(gateEnv(surface), async () => {
                await drain(
                    adapter.resumeMessage!(
                        resumeCtx(surface.framework, surface.runtime, {
                            daemonId: RUNNER_DAEMON_ID
                        } as never)
                    )
                )
            })
            const resume = seam.rpcs.find((rpc) => rpc.method === 'exec.resume')
            assert.ok(resume, `${key}: resume did not reach the daemon`)
            assert.equal(
                'env' in resume.payload,
                false,
                `${key}: a resume re-attaches; it must not re-send env`
            )
        })
}

for (const surface of execEnvSurfaces.filter(
    (s) => s.transport === 'gateway-http'
)) {
    const key = execEnvSurfaceKey(surface)

    test(`${key} never reaches the exec seam`, async () => {
        // The declared absence: a resident-service turn is an HTTP call, so
        // nothing may be spawned and no env may be injected anywhere.
        const seam = await dispatch(surface)
        assert.deepEqual(
            seam.rpcs.map((rpc) => rpc.method),
            [],
            `${key}: a gateway turn must dispatch no daemon RPC`
        )
        assert.equal(seam.streams.length, 0, `${key}: must spawn nothing`)
        assert.equal(seam.runnerDrivers.length, 0)
    })
}

// --- The behaviour → row direction ------------------------------------------

test('every transport observed at the seam has a declared surface', async () => {
    // The completeness test proves declared rows exist. This proves the
    // converse: an adapter that starts reaching the seam some new way — a new
    // transport branch, or an existing one on a runtime it never used — cannot
    // ship without landing a row first.
    const undeclared: string[] = []
    // Every seam shape maps back to a transport: a factory-driver stream is
    // the runtime's direct transport, a runner stream is the swap, a gateway
    // call and each RPC method name themselves. A new kind of seam event must
    // extend this observer, or its transport ships unswept.
    const factoryTransport: Partial<Record<AgentRuntime, ExecTransport>> = {
        sprites: 'sprite-exec',
        daemon: 'daemon-exec',
        k8s: 'pod-exec'
    }
    const observedFor = (
        seam: Seam,
        runtime: AgentRuntime
    ): ExecTransport[] => {
        const seen = new Set<ExecTransport>()
        for (const stream of seam.streams) {
            const transport =
                stream.via === 'runner'
                    ? 'runner-exec'
                    : factoryTransport[runtime]
            if (transport) seen.add(transport)
        }
        if (seam.runnerDrivers.length > 0) seen.add('runner-exec')
        if (seam.gatewayCalls.length > 0) seen.add('gateway-http')
        for (const rpc of seam.rpcs) {
            if (rpc.method === 'turn.start') seen.add('turn-rpc')
        }
        return [...seen]
    }

    for (const framework of Object.keys(
        frameworkCapabilities
    ) as AgentFramework[]) {
        const capability = frameworkCapabilities[framework]
        if (capability.kind === 'external') continue
        for (const runtime of capability.runtimes as AgentRuntime[]) {
            // A sprite turn reaches different transports with and without a
            // carrying runner, so both variants are swept; daemon and k8s
            // have a single shape.
            const carriers =
                runtime === 'sprites'
                    ? [RUNNER_DAEMON_ID, undefined]
                    : [undefined]
            for (const carrier of carriers) {
                const seam = createSeam()
                const adapter = buildAdapter(seam, {
                    framework,
                    runtime,
                    // Everything a daemon could possibly advertise, so no
                    // cell is hidden behind a capability this sweep forgot
                    // to name.
                    clientFeatures: [
                        'turn.openclaw',
                        'turn.hermes',
                        'exec.resume'
                    ]
                })
                stubGatewayResolution(adapter)
                await withEnv(
                    {
                        MF_OPENCLAW_TURN_RPC: '1'
                    },
                    async () => {
                        await withGatewayFetch(seam, async () => {
                            await drain(
                                adapter.sendMessage(
                                    adapterCtx(framework, runtime, {
                                        ...(carrier
                                            ? { runnerDaemonId: carrier }
                                            : {})
                                    } as never),
                                    USER_MESSAGE
                                )
                            )
                        })
                    }
                )
                for (const transport of observedFor(seam, runtime))
                    if (!execEnvSurface(framework, runtime, transport))
                        undeclared.push(
                            `${framework} × ${runtime} × ${transport}`
                        )
            }
        }
    }
    assert.deepEqual(undeclared, [])
})
