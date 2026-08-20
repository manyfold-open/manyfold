import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import { SpritesError } from '@manyfold/sprites'
import {
    AgentDiagnosticsService,
    duKilobytesToBytes,
    nestedConfigBytes,
    parseDuKilobytes,
    redactDiagnosticText
} from '../src/modules/agents/agent-diagnostics.service'

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

test('redactDiagnosticText removes secret-like output', () => {
    const raw =
        'Bearer abc.def OPENAI_API_KEY=sk-test1234567890 eyJhbGciOi token'
    const redacted = redactDiagnosticText(raw)
    assert.equal(redacted.includes('abc.def'), false)
    assert.equal(redacted.includes('sk-test1234567890'), false)
    assert.equal(redacted.includes('eyJhbGciOi'), false)
    assert.match(redacted, /OPENAI_API_KEY=\[REDACTED\]/)
})

test('storageUsage returns a failed item when k8s pod resolution is unavailable', async () => {
    const service = diagnosticsService({
        agent: diagnosticsAgent({ runtime: 'k8s', namespace: null }),
        runtime: diagnosticsRuntime({ kind: 'k8s', namespace: null })
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.equal(result.items[0].status, 'failed')
    assert.equal(result.items[0].bytes, 0)
    assert.match(result.items[0].message, /has no k8s namespace/)
})

test('storageUsage executes through daemon runtime kind even when agent runtime is stale', async () => {
    let capturedCmd: string[] | null = null
    const daemonRegistry = {
        isOnline: () => true,
        streamRpc: (args: {
            payload: { cmd?: string[] }
            onEvent?: (kind: string, data: string) => void
        }) => {
            capturedCmd = args.payload.cmd ?? null
            args.onEvent?.('stdout', '2\t/workspace\n')
            return {
                refId: 'ref-1',
                result: Promise.resolve({ exitCode: 0 }),
                cancel: () => {}
            }
        }
    }
    const service = diagnosticsService({
        agent: diagnosticsAgent({
            runtime: 'k8s',
            daemonId: null,
            namespace: null
        }),
        runtime: diagnosticsRuntime({
            kind: 'daemon',
            daemonId: 'daemon-1',
            namespace: null
        }),
        daemonRegistry
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    assert.equal(result.items[0].status, 'ok')
    assert.equal(result.items[0].bytes, 2048)
    const command = capturedCmd as string[] | null
    assert.deepEqual(command?.slice(0, 2), ['bash', '-lc'])
})

const diagnosticsAgent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        userId: 'user-1',
        name: 'agent',
        framework: 'claude-code',
        runtime: 'k8s',
        status: 'running',
        runtimeId: 'runtime-1',
        internalId: 'agent-1',
        workspacePath: '/workspace',
        mountPath: '/workspace',
        fileRoots: [],
        namespace: 'nca-dev',
        ingressHost: null,
        clusterId: 'cluster-1',
        accountId: null,
        daemonId: null,
        spriteName: null,
        spriteId: null,
        extras: {},
        model: null,
        currentPhase: null,
        failureReason: null,
        spriteStatus: null,
        k8sPodPhase: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        lastReconciledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as Agent

const diagnosticsRuntime = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'runtime-1',
        userId: 'user-1',
        name: 'runtime',
        framework: 'claude-code',
        kind: 'k8s',
        status: 'ready',
        accountId: null,
        spriteName: null,
        spriteId: null,
        clusterId: 'cluster-1',
        daemonId: null,
        homeDir: null,
        workspaceBaseDir: null,
        capabilitiesJson: {},
        lastSeenAt: null,
        namespace: 'nca-dev',
        ingressHost: null,
        mountPath: '/workspace',
        primaryAgentId: 'agent-1',
        controlUiEnabled: true,
        dashboardEnabled: false,
        currentPhase: null,
        failureReason: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as AgentRuntimeRow

const diagnosticsService = (args: {
    agent: Agent
    runtime: AgentRuntimeRow
    daemonRegistry?: unknown
}): AgentDiagnosticsService =>
    new AgentDiagnosticsService(
        {
            findForCaller: async () => args.agent
        } as never,
        {
            findById: async () => args.runtime
        } as never,
        {} as never,
        {} as never,
        {} as never,
        (args.daemonRegistry ?? {
            isOnline: () => false,
            streamRpc: () => {
                throw new Error('unexpected daemon rpc')
            }
        }) as never
    )

const spriteDiagnosticsSetup = (args: {
    framework: Agent['framework']
    sprite: { status: string; id?: string } | 'not_found'
    runtimeOverrides?: Partial<AgentRuntimeRow>
    probeExitCode?: number
}) => {
    const agent = diagnosticsAgent({
        framework: args.framework,
        runtime: 'sprites',
        spriteName: 'sprite-1',
        accountId: 'account-1'
    })
    const runtime = diagnosticsRuntime({
        kind: 'sprites',
        framework: args.framework,
        spriteName: 'sprite-1',
        accountId: 'account-1',
        ...args.runtimeOverrides
    })
    const service = diagnosticsService({ agent, runtime })
    const probeCalls: string[][] = []
    Object.assign(service, {
        spriteClientFor: async () => ({
            getSprite: async () => {
                if (args.sprite === 'not_found')
                    throw new SpritesError('not_found', 'sprite missing', 404)
                return args.sprite
            }
        }),
        runCommand: async (_agent: Agent, input: { cmd: string[] }) => {
            probeCalls.push(input.cmd)
            return {
                exitCode: args.probeExitCode ?? 0,
                stdout: '',
                stderr: ''
            }
        }
    })
    return { agent, service, probeCalls }
}

test('storageUsage on a sleeping service sprite skips du without any exec', async () => {
    const { service, probeCalls } = spriteDiagnosticsSetup({
        framework: 'openclaw',
        sprite: { status: 'cold' },
        runtimeOverrides: {
            serviceStatus: 'ready',
            serviceStatusAt: new Date()
        }
    })

    const result = await service.storageUsage('user-1', 'agent-1', false)

    // WHY: du is an exec and would wake/bill a sleeping service sprite —
    // storageUsage must report it asleep without ever execing.
    assert.equal(probeCalls.length, 0, 'du must not run on a sleeping sprite')
    assert.equal(result.totalBytes, 0)
    for (const item of result.items) {
        assert.equal(item.status, 'skipped')
        assert.match(item.message, /asleep/)
    }
})
