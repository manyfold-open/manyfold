import {
    MF_RUNTIME_IDENTITY_ENV_KEYS,
    PATH_PREPEND_LOCAL_BIN
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    execEnvSurfaceKey,
    execEnvSurfaces,
    type ExecEnvSurface
} from './exec-env-contract'
import {
    adapterCtx,
    buildAdapter,
    createSeam,
    drain,
    effectiveEnv,
    resumeCtx,
    CONNECTION_MARKERS,
    EXTRAS_MARKERS,
    IDENTITY_MARKERS,
    PROVIDER_MARKERS,
    USER_MESSAGE,
    type CapturedStream,
    type Seam
} from './exec-env-harness'

// One generated test per declared driver-seam cell. Generating them (rather
// than looping inside a single test) means a broken cell names itself and does
// not mask its siblings — which is the whole reason for a matrix: #581 was a
// single cell of a row whose other cells were fine.

const RUNNER_DAEMON_ID = 'dh_runner'

const DRIVER_SEAM_TRANSPORTS = [
    'sprite-exec',
    'runner-exec',
    'daemon-exec',
    'pod-exec'
] as const

type DriverSeamTransport = (typeof DRIVER_SEAM_TRANSPORTS)[number]

const driverSeamSurfaces = execEnvSurfaces.filter((surface) =>
    (DRIVER_SEAM_TRANSPORTS as readonly string[]).includes(surface.transport)
)

const dispatch = async (
    surface: ExecEnvSurface,
    extraCtx: Record<string, unknown> = {}
): Promise<Seam> => {
    const seam = createSeam()
    const adapter = buildAdapter(seam, {
        framework: surface.framework,
        runtime: surface.runtime
    })
    await drain(
        adapter.sendMessage(
            adapterCtx(surface.framework, surface.runtime, {
                ...(surface.transport === 'runner-exec'
                    ? { runnerDaemonId: RUNNER_DAEMON_ID }
                    : {}),
                ...extraCtx
            } as never),
            USER_MESSAGE
        )
    )
    return seam
}

const soleStream = (seam: Seam, key: string): CapturedStream => {
    assert.equal(
        seam.streams.length,
        1,
        `${key}: expected exactly one dispatch at the exec seam, saw ${seam.streams.length}`
    )
    return seam.streams[0]
}

const assertAbsent = (
    env: Record<string, string>,
    markers: Record<string, string>,
    key: string,
    group: string
): void => {
    for (const name of Object.keys(markers))
        assert.equal(
            name in env,
            false,
            `${key}: ${group} is declared absent but ${name} was dispatched`
        )
}

for (const surface of driverSeamSurfaces) {
    const key = execEnvSurfaceKey(surface)
    const transport = surface.transport as DriverSeamTransport

    test(`${key} dispatches through the declared transport`, async () => {
        const seam = await dispatch(surface)
        const stream = soleStream(seam, key)
        if (transport === 'runner-exec') {
            assert.equal(
                seam.runnerDrivers.length,
                1,
                `${key}: the turn must swap onto the runner transport`
            )
            assert.equal(seam.runnerDrivers[0].daemonId, RUNNER_DAEMON_ID)
            assert.equal(stream.via, 'runner')
            assert.equal(
                stream.execHandle,
                'msg_marker',
                `${key}: a runner turn must pin an exec ref so it can be resumed`
            )
        } else {
            assert.equal(
                seam.runnerDrivers.length,
                0,
                `${key}: this cell must use the driver the factory returned`
            )
            assert.equal(stream.via, 'factory')
        }
    })

    test(`${key} injects exactly the declared env groups`, async () => {
        const seam = await dispatch(surface)
        const stream = soleStream(seam, key)
        const env = effectiveEnv(stream, seam.runnerDrivers[0]?.baseEnv)

        if (surface.identity === 'per-exec') {
            for (const name of MF_RUNTIME_IDENTITY_ENV_KEYS)
                assert.equal(
                    env[name],
                    IDENTITY_MARKERS[name],
                    `${key}: identity is declared per-exec but ${name} did not reach the child`
                )
        } else {
            // All four keys, not just the token: the non-secret ones leaking
            // onto a daemon-local or pod-secret cell is the same undeclared
            // injection path, just without a credential attached.
            for (const name of MF_RUNTIME_IDENTITY_ENV_KEYS)
                assert.equal(
                    name in env,
                    false,
                    `${key}: identity is declared ${surface.identity}, but ${name} was dispatched`
                )
        }

        if (surface.connections === 'per-exec')
            for (const [name, value] of Object.entries(CONNECTION_MARKERS))
                assert.equal(env[name], value, `${key}: ${name} not carried`)
        else assertAbsent(env, CONNECTION_MARKERS, key, 'connection env')

        if (surface.extras === 'per-exec')
            for (const [name, value] of Object.entries(EXTRAS_MARKERS))
                assert.equal(env[name], value, `${key}: ${name} not carried`)
        else assertAbsent(env, EXTRAS_MARKERS, key, 'agent extras')

        const providerValues = Object.values(PROVIDER_MARKERS)
        const dispatchedProvider = Object.values(env).some((value) =>
            providerValues.includes(value)
        )
        assert.equal(
            dispatchedProvider,
            surface.providerCreds === 'per-exec',
            `${key}: provider credentials are declared ${surface.providerCreds}`
        )
    })

    if (surface.providerCreds === 'per-exec-model-config')
        test(`${key} injects provider credentials only with a platform model config`, async () => {
            // The asymmetry this value exists for: a BYOD daemon authenticates
            // itself unless the turn is pinned to a platform-managed model.
            const withConfig = await dispatch(surface, {
                modelConfig: {
                    framework: surface.framework,
                    model: 'claude-sonnet-4-5',
                    intelligence: 'medium'
                }
            })
            const env = effectiveEnv(
                soleStream(withConfig, key),
                withConfig.runnerDrivers[0]?.baseEnv
            )
            const providerValues = Object.values(PROVIDER_MARKERS)
            assert.equal(
                Object.values(env).some((value) =>
                    providerValues.includes(value)
                ),
                true,
                `${key}: a platform model config must bring platform credentials`
            )
        })

    test(`${key} activates the framework binary the declared way`, async () => {
        const seam = await dispatch(surface)
        const cmd = soleStream(seam, key).cmd.join(' ')
        const prepends = cmd.includes(PATH_PREPEND_LOCAL_BIN)
        if (surface.path === 'adapter-bootstrap')
            assert.equal(
                prepends,
                true,
                `${key}: declared adapter-bootstrap, but the argv carries no activation prepend`
            )
        else
            assert.equal(
                prepends,
                false,
                `${key}: declared ${surface.path}, so the argv must not prepend PATH itself`
            )
    })

    if (surface.resume === 'attach-no-env')
        test(`${key} resumes by re-attaching, carrying no env`, async () => {
            // A resume does not respawn, so re-sending identity would be a
            // second, unverifiable injection path. The RPC payload's own
            // absence of an env key is pinned in runner-exec-identity-env.
            const seam = createSeam()
            const adapter = buildAdapter(seam, {
                framework: surface.framework,
                runtime: surface.runtime
            })
            assert.ok(
                adapter.resumeMessage,
                `${key}: declared resumable but the adapter has no resume path`
            )
            await drain(
                adapter.resumeMessage(
                    resumeCtx(surface.framework, surface.runtime)
                )
            )
            assert.equal(
                seam.runnerDrivers.length,
                1,
                `${key}: resume must go through the daemon transport`
            )
            assert.equal(
                seam.runnerDrivers[0].baseEnv,
                undefined,
                `${key}: resume must not carry a base env`
            )
        })
}
