import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent, HostDaemonRow, RuntimeHostRow } from '@manyfold/db'
import {
    AgentDiagnosticsService,
    duKilobytesToBytes,
    nestedConfigBytes,
    parseDuKilobytes,
    redactDiagnosticText
} from '../src/modules/agents/agent-diagnostics.service'
import {
    contextOf,
    hostRow,
    k8sHostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

test('parseDuKilobytes parses successful du output', () => {
    assert.equal(parseDuKilobytes('12\t/home/sprite/.nca/workspaces/a\n'), 12)
    assert.equal(duKilobytesToBytes(12), 12288)
})

test('parseDuKilobytes treats missing sentinel as absent directory', () => {
    assert.equal(parseDuKilobytes('__NCA_MISSING__\n'), null)
    assert.equal(duKilobytesToBytes(null), 0)
})

test('nestedConfigBytes subtracts workspace usage when workspace is nested', () => {
    assert.equal(
        nestedConfigBytes(
            10_000,
            4_000,
            '/home/node/.hermes',
            '/home/node/.hermes/profiles/default'
        ),
        6_000
    )
    assert.equal(
        nestedConfigBytes(
            10_000,
            4_000,
            '/home/node/.hermes',
            '/home/node/other-workspace'
        ),
        10_000
    )
})

test('diagnostic attribution never clamps contradictory nested measurements into a partition', () => {
    assert.equal(nestedConfigBytes(10, 20, '/config', '/config/workspace'), null)
    assert.equal(nestedConfigBytes(30, 20, '/workspace/config', '/workspace'), null)
    assert.equal(nestedConfigBytes(10, 20, '/same', '/same'), null)
    assert.equal(nestedConfigBytes(20, 20, '/same/', '/same'), 0)
    assert.equal(nestedConfigBytes(10, 20, '/workspace/config', '/workspace'), 0)
    assert.equal(nestedConfigBytes(10, 20, '/foo', '/foobar'), 10)
    assert.equal(nestedConfigBytes(10, 20, '~/.openclaw', '/home/sprite/.openclaw/workspace'), null)
})

test('redactDiagnosticText removes secret-like output', () => {
    const raw =
        'Bearer abc.def OPENAI_API_KEY=sk-test1234567890 eyJhbGciOi token'
    const redacted = redactDiagnosticText(raw)
    assert.equal(redacted.includes('abc.def'), false)
    assert.equal(redacted.includes('sk-test1234567890'), false)
    assert.equal(redacted.includes('eyJhbGciOi'), false)
    assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/)
})

const diagnosticsAgent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        userId: 'user-1',
        name: 'agent',
        framework: 'claude-code',
        status: 'ready',
        runtimeId: 'runtime-1',
        internalId: 'agent-1',
        workspacePath: '/workspace',
        mountPath: '/workspace',
        fileRoots: [],
        extras: {},
        model: null,
        currentPhase: null,
        failureReason: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        lastReconciledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as Agent

type Exec = (req: {
    cmd: string[]
}) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// The service reads the agent with its machine and runs du through the
// host daemon's exec; both are the harness's to choose, and so are the
// admission and the sandbox measurement a refresh goes through.
const diagnosticsService = (args: {
    agent: Agent
    host: RuntimeHostRow | null
    daemon?: HostDaemonRow | null
    exec?: Exec
    resolve?: () => Promise<never>
    admit?: (input: { userId: string; hostId: string }) => Promise<unknown>
    measure?: (hostId: string) => Promise<boolean>
}): AgentDiagnosticsService => {
    const ctx = contextOf({
        agent: args.agent,
        runtime: runtimeRow({
            id: 'runtime-1',
            userId: 'user-1',
            framework: args.agent.framework,
            hostId: args.host?.id ?? null
        }),
        host: args.host,
        daemon: args.daemon
    })
    return new AgentDiagnosticsService(
        { contextForCaller: async () => ctx } as never,
        {
            forRuntime: async () => {
                if (args.resolve) return args.resolve()
                if (!args.exec) throw new Error('unexpected exec')
                return { run: args.exec }
            }
        } as never,
        {
            reserveActiveSlot: async (input: {
                userId: string
                hostId: string
            }) => {
                if (!args.admit) throw new Error('unexpected admission')
                return args.admit(input)
            }
        } as never,
        {
            measureHostNow: async (hostId: string) => {
                if (!args.measure) throw new Error('unexpected measurement')
                return args.measure(hostId)
            }
        } as never
    )
}

test('storageUsage reports a failed item when the host exec cannot be resolved', async () => {
    const service = diagnosticsService({
        agent: diagnosticsAgent(),
        host: k8sHostRow({ id: 'pdh_1' }),
        resolve: async () => {
            throw new Error('pod daemon offline')
        }
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.equal(result.items[0].status, 'failed')
    assert.equal(result.items[0].bytes, null)
    assert.equal(result.totalBytes, null)
    assert.match(result.items[0].message, /Usage check unavailable/)
})

test('storageUsage runs du through the daemon of the agent machine', async () => {
    let capturedCmd: string[] | null = null
    const service = diagnosticsService({
        agent: diagnosticsAgent(),
        host: hostRow({ id: 'dh-1' }),
        exec: async (req) => {
            capturedCmd = req.cmd
            return { exitCode: 0, stdout: '2\t/workspace\n', stderr: '' }
        }
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.equal(result.items[0].status, 'ok')
    assert.equal(result.items[0].bytes, 2048)
    const command = capturedCmd as string[] | null
    assert.deepEqual(command?.slice(0, 2), ['bash', '-lc'])
})

const spriteDiagnosticsSetup = (args: {
    framework: Agent['framework']
    power: 'stopped' | 'suspended' | 'running' | null
}) => {
    const agent = diagnosticsAgent({ framework: args.framework })
    const probeCalls: string[][] = []
    const service = diagnosticsService({
        agent,
        host: spritesHostRow({ powerState: args.power }),
        daemon: args.power === 'running' ? undefined : null,
        exec: async (req) => {
            probeCalls.push(req.cmd)
            return { exitCode: 0, stdout: '', stderr: '' }
        }
    })
    return { agent, service, probeCalls }
}

test('storageUsage on a sleeping service sprite skips du without any exec', async () => {
    const { service, probeCalls } = spriteDiagnosticsSetup({
        framework: 'openclaw',
        power: 'stopped'
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    // WHY: du is an exec and would wake/bill a sleeping service sprite —
    // storageUsage must report it asleep without ever execing.
    assert.equal(probeCalls.length, 0, 'du must not run on a sleeping sprite')
    assert.equal(result.totalBytes, null)
    assert.equal(result.measuredAt, null)
    assert.equal(result.scope, 'agent-paths')
    assert.equal(result.asleep, true)
    for (const item of result.items) {
        assert.equal(item.status, 'skipped')
        assert.equal(item.bytes, null)
        assert.match(item.message, /Not measured yet/)
    }
})

const MEASURED_AT = new Date('2026-09-28T11:39:58.536Z')
const measuredAgent = (
    breakdown: Partial<NonNullable<Agent['storageBreakdown']>> = {}
): Agent =>
    diagnosticsAgent({
        framework: 'pi',
        workspacePath: '/home/sprite/.manyfold/workspaces/agent-1',
        fileRoots: [
            {
                id: 'workspace',
                label: 'Workspace',
                path: '/home/sprite/.manyfold/workspaces/agent-1',
                writable: true
            },
            {
                id: 'pi-home',
                label: 'Pi config',
                path: '/home/sprite/.pi',
                writable: true
            }
        ],
        storageBytes: 1056,
        storageMeasuredAt: MEASURED_AT,
        storageBreakdown: {
            formatVersion: 1,
            workspaceBytes: 1056,
            homeBytes: 8056,
            totalBytes: 9112,
            measuredVia: 'df',
            ...breakdown
        }
    })

// WHY: a sandbox's paths are measured with the sandbox, which keeps that
// reading on the agent. The report is that reading, the same asleep or awake,
// and reading it must never exec: an exec wakes a sleeping sandbox.
for (const power of ['running', 'suspended', 'stopped'] as const)
    test(`a ${power} sandbox reports its last measurement without any exec`, async () => {
        const service = diagnosticsService({
            agent: measuredAgent(),
            host: spritesHostRow({ powerState: power })
        })

        const result = await service.storageUsage('user-1', 'agent-1', false)

        assert.deepEqual(
            result.items.map((item) => [item.label, item.path, item.bytes, item.status]),
            [
                ['Workspace', '/home/sprite/.manyfold/workspaces/agent-1', 1056, 'ok'],
                ['Pi config', '/home/sprite/.pi', 8056, 'ok']
            ]
        )
        assert.equal(result.totalBytes, 9112)
        assert.equal(result.measuredAt, MEASURED_AT.toISOString())
        assert.equal(result.asleep, power !== 'running')
    })

test('a sandbox reading in an older format reads as not measured', async () => {
    const service = diagnosticsService({
        agent: measuredAgent({ formatVersion: undefined }),
        host: spritesHostRow()
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.deepEqual(
        result.items.map((item) => [item.bytes, item.status]),
        [
            [null, 'skipped'],
            [null, 'skipped']
        ]
    )
    assert.equal(result.totalBytes, null)
    assert.equal(result.measuredAt, null)
})

test('a home the last measurement could not read leaves the total unknown', async () => {
    const service = diagnosticsService({
        agent: measuredAgent({ homeBytes: null, totalBytes: null }),
        host: spritesHostRow()
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.equal(result.items[0].bytes, 1056)
    assert.equal(result.items[1].bytes, null)
    assert.equal(result.items[1].status, 'warning')
    assert.equal(result.totalBytes, null)
})

// WHY: the refresh is what may wake a sleeping sandbox, so it is admitted the
// way every wake is (the quota and the running write happen there) before
// anything execs.
test('refreshing a sandbox admits the wake, measures it, then reports the new reading', async () => {
    const agent = measuredAgent()
    const steps: string[] = []
    const service = diagnosticsService({
        agent,
        host: spritesHostRow({ id: 'sbx_1', powerState: 'stopped' }),
        admit: async (input) => {
            steps.push(`admit ${input.userId} ${input.hostId}`)
        },
        measure: async (hostId) => {
            steps.push(`measure ${hostId}`)
            agent.storageBreakdown = {
                ...agent.storageBreakdown!,
                workspaceBytes: 4096,
                totalBytes: 12152
            }
            return true
        }
    })

    const result = await service.refreshStorageUsage('user-1', 'agent-1', false)

    assert.deepEqual(steps, ['admit user-1 sbx_1', 'measure sbx_1'])
    assert.equal(result.items[0].bytes, 4096)
    assert.equal(result.totalBytes, 4096 + 8056)
})

test('a refresh the sandbox refuses or cannot measure fails without a new reading', async () => {
    let measured = 0
    const refused = diagnosticsService({
        agent: measuredAgent(),
        host: spritesHostRow({ powerState: 'stopped' }),
        admit: async () => {
            throw new Error('concurrent active sprite limit reached')
        },
        measure: async () => {
            measured++
            return true
        }
    })
    await assert.rejects(
        refused.refreshStorageUsage('user-1', 'agent-1', false),
        /concurrent active sprite limit reached/
    )
    assert.equal(measured, 0, 'nothing execs before the wake is admitted')

    const failed = diagnosticsService({
        agent: measuredAgent(),
        host: spritesHostRow(),
        admit: async () => undefined,
        measure: async () => false
    })
    await assert.rejects(
        failed.refreshStorageUsage('user-1', 'agent-1', false),
        /could not be measured/
    )
})

test('refreshing an agent on its own machine measures its paths directly', async () => {
    let runs = 0
    const service = diagnosticsService({
        agent: diagnosticsAgent(),
        host: hostRow({ id: 'dh-1' }),
        exec: async () => {
            runs++
            return { exitCode: 0, stdout: '2\t/workspace\n', stderr: '' }
        }
    })

    const result = await service.refreshStorageUsage('user-1', 'agent-1', false)

    assert.equal(runs, 1)
    assert.equal(result.items[0].bytes, 2048)
    assert.equal(result.measuredAt, result.checkedAt)
})

for (const [label, power] of [
    ['cold', 'stopped'],
    ['warm', 'suspended'],
    ['not_found', null]
] as const)
    test(`coding sprite diagnostic avoids exec for ${label}`, async () => {
        const { service, probeCalls } = spriteDiagnosticsSetup({
            framework: 'codex',
            power
        })
        const result = await service.storageUsage('user-1', 'agent-1', false)
        assert.equal(probeCalls.length, 0)
        assert.equal(result.totalBytes, null)
        assert.equal(result.asleep, power !== null)
        assert.equal(result.items[0].bytes, null)
    })
