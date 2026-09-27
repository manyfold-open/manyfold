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
// host daemon's exec; both are the harness's to choose.
const diagnosticsService = (args: {
    agent: Agent
    host: RuntimeHostRow | null
    daemon?: HostDaemonRow | null
    exec?: Exec
    resolve?: () => Promise<never>
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
    assert.equal(result.scope, 'agent-paths')
    assert.equal(result.asleep, true)
    for (const item of result.items) {
        assert.equal(item.status, 'skipped')
        assert.equal(item.bytes, null)
        assert.match(item.message, /asleep/)
    }
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
