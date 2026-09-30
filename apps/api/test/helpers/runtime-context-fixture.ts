import {
    agentAvailability,
    daemonOnline,
    placementOf,
    runtimeAvailability,
    type RuntimeProviderKind
} from '@manyfold/shared'
import type {
    Agent,
    AgentRuntimeRow,
    HostDaemonRow,
    RuntimeHostRow
} from '@manyfold/db'
import type { RuntimeContext } from '../../src/modules/hosts/runtime-context.service'
import { CLI_AT_FLOOR } from './cli-floor'

// Row builders for the host model (ADR-0037): a runtime on a host with one
// daemon, and the derived facts RuntimeContextService would compute.

export const runtimeRow = (
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: 'art_fixture',
        userId: 'user-1',
        name: 'fixture-runtime',
        framework: 'claude-code',
        hostId: 'rth_fixture',
        status: 'ready',
        currentPhase: null,
        failureReason: null,
        mountPath: '/workspace',
        capabilitiesJson: {},
        defaultAuthProfileId: null,
        controlUiEnabled: true,
        dashboardEnabled: false,
        dashboardState: null,
        serviceStatus: 'unknown',
        serviceStatusAt: null,
        lastBootstrappedAt: null,
        frameworkVersion: null,
        frameworkVersionCheckedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides
    }) as AgentRuntimeRow

export const hostRow = (
    overrides: Partial<RuntimeHostRow> = {}
): RuntimeHostRow =>
    ({
        id: 'rth_fixture',
        userId: 'user-1',
        kind: 'local',
        providerId: null,
        providerRef: null,
        name: 'fixture-host',
        status: 'ready',
        failureReason: null,
        generation: 1,
        powerState: null,
        powerChangedAt: null,
        homeDir: '/home/fixture',
        workspaceBaseDir: null,
        skillsDir: null,
        cpuMillicores: null,
        memoryMb: null,
        diskGb: null,
        region: null,
        keepAwake: false,
        terminalEnabled: false,
        terminalModelCredentials: false,
        emptiedAt: null,
        execCooldownUntil: null,
        activeAccrualSince: null,
        storageBytes: null,
        storageMeasuredAt: null,
        storageBreakdown: null,
        storageAttemptId: null,
        storageLeaseUntil: null,
        storageRetryAt: null,
        storageFailureCount: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides
    }) as RuntimeHostRow

export const spritesHostRow = (
    overrides: Partial<RuntimeHostRow> = {}
): RuntimeHostRow =>
    hostRow({
        kind: 'hosted',
        providerId: 'rtp_sprites',
        providerRef: { kind: 'sprites', spriteName: 'sprite-1', spriteId: null },
        powerState: 'running',
        homeDir: '/home/sprite',
        ...overrides
    })

export const k8sHostRow = (
    overrides: Partial<RuntimeHostRow> = {}
): RuntimeHostRow =>
    hostRow({
        kind: 'hosted',
        providerId: 'rtp_k8s',
        providerRef: {
            kind: 'k8s',
            namespace: 'nca-dev',
            ingressHost: 'agent.example.test',
            podPhase: 'Running'
        },
        powerState: 'running',
        homeDir: '/home/node',
        ...overrides
    })

export const daemonRow = (
    overrides: Partial<HostDaemonRow> = {}
): HostDaemonRow =>
    ({
        hostId: 'rth_fixture',
        userId: 'user-1',
        daemonUuid: 'uuid-fixture',
        tokenId: null,
        hostname: 'fixture',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: CLI_AT_FLOOR,
        herdrVersion: null,
        startupMethod: 'manual',
        clientFeatures: [],
        terminalPty: true,
        detectedFrameworks: [],
        registeredAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date(),
        lastIp: null,
        rpcInstanceId: 'api-1',
        rpcConnectionToken: 'token',
        rpcInbox: 'inbox',
        rpcConnectedAt: new Date(),
        rpcLastSeenAt: new Date(),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        ...overrides
    }) as HostDaemonRow

export interface ContextParts {
    agent?: Agent | null
    runtime?: AgentRuntimeRow
    host?: RuntimeHostRow | null
    daemon?: HostDaemonRow | null
    providerKind?: RuntimeProviderKind | null
}

// The derived facts exactly as RuntimeContextService.build computes them.
export function contextOf(
    parts: ContextParts & { agent: Agent }
): RuntimeContext & { agent: Agent }
export function contextOf(parts?: ContextParts): RuntimeContext
export function contextOf(parts: ContextParts = {}): RuntimeContext {
    const host = parts.host === undefined ? hostRow() : parts.host
    const runtime =
        parts.runtime ??
        runtimeRow({ hostId: host?.id ?? null, userId: host?.userId })
    const daemon =
        parts.daemon === undefined
            ? host
                ? daemonRow({ hostId: host.id, userId: host.userId })
                : null
            : parts.daemon
    const providerKind =
        parts.providerKind === undefined
            ? host?.providerRef?.kind ?? null
            : parts.providerKind
    const agent = parts.agent ?? null
    const online = daemonOnline(daemon)
    return {
        agent,
        runtime,
        host,
        daemon,
        providerKind,
        placement: placementOf(host ? { kind: host.kind, providerKind } : null),
        daemonOnline: online,
        availability: agent
            ? agentAvailability({ agent, runtime, host, daemonOnline: online })
            : runtimeAvailability({ runtime, host, daemonOnline: online })
    }
}

// A daemon row that is not online: its heartbeat is outside the presence
// window.
export const offlineDaemonRow = (
    overrides: Partial<HostDaemonRow> = {}
): HostDaemonRow =>
    daemonRow({
        lastSeenAt: new Date(0),
        rpcLastSeenAt: new Date(0),
        rpcConnectedAt: null,
        ...overrides
    })

// A RuntimeContextService stand-in that answers every lookup with the same
// context (or one chosen per id).
export const fakeRuntimeContext = (
    resolve: RuntimeContext | ((id: string) => RuntimeContext | null)
) => ({
    forAgent: async (id: string) =>
        typeof resolve === 'function' ? resolve(id) : resolve,
    forRuntime: async (id: string) =>
        typeof resolve === 'function' ? resolve(id) : resolve,
    build: (
        agent: Agent | null,
        runtime: AgentRuntimeRow,
        host: RuntimeHostRow | null,
        daemon: HostDaemonRow | null,
        providerKind: RuntimeProviderKind | null
    ) => contextOf({ agent, runtime, host, daemon, providerKind })
})

// A HostDaemonAccess stand-in: the daemon is exactly as online as its row.
export const fakeHostAccess = () => ({
    ensure: async (args: {
        host: RuntimeHostRow
        daemon: HostDaemonRow | null
    }) => ({
        daemon: args.daemon,
        online: daemonOnline(args.daemon),
        fallbackReason: daemonOnline(args.daemon)
            ? undefined
            : ('runner_unavailable' as const)
    }),
    requireOnline: async (args: {
        host: RuntimeHostRow
        daemon: HostDaemonRow | null
    }) => {
        if (!daemonOnline(args.daemon))
            throw new Error(`${args.host.name} is offline; start its daemon`)
        return args.host.id
    }
})
