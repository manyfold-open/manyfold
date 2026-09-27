import type { SandboxSummary } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

// Rows as the API ships them after ADR-0037: an agent carries its host one
// hop away (hostId/hostName/powerState/daemonOnline) and a derived
// availability; a sandbox row IS its host. Tests override what they assert.
let seq = 0

export const makeAgentSummary = (over: Partial<SdkAgent> = {}): SdkAgent => {
    seq += 1
    return {
        id: `agt_${seq}`,
        userId: 'usr_1',
        runtimeId: `art_${seq}`,
        hostId: `sbx_${seq}`,
        hostName: `sandbox-${seq}`,
        hostKind: 'hosted',
        providerKind: 'sprites',
        powerState: 'running',
        daemonOnline: true,
        daemonNeedsUpgrade: false,
        keepAwake: false,
        name: `Agent ${seq}`,
        framework: 'claude-code',
        frameworkVersion: null,
        frameworkLatestVersion: null,
        frameworkUpgradeAvailable: false,
        frameworkVersionBlockedReason: null,
        cliVersion: null,
        cliLatestVersion: null,
        cliUpdateAvailable: false,
        runtime: 'sprites',
        status: 'ready',
        availability: 'available',
        mountPath: '/',
        endpointUrl: null,
        controlUiEnabled: false,
        dashboardEnabled: false,
        dashboardState: null,
        currentPhase: null,
        failureReason: null,
        internalId: 'int',
        model: null,
        extras: {},
        workspacePath: null,
        workspaceBytes: null,
        workspaceMeasuredAt: null,
        startedAt: null,
        lastActiveAt: null,
        lastMessageAt: null,
        lastBootstrappedAt: null,
        lastReconciledAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over
    }
}

// A self-owned computer's agent: local host, no provider, its daemon online.
export const makeDaemonAgentSummary = (
    over: Partial<SdkAgent> = {}
): SdkAgent =>
    makeAgentSummary({
        runtime: 'daemon',
        hostKind: 'local',
        providerKind: null,
        powerState: null,
        ...over
    })

export const makeSandboxSummary = (
    over: Partial<SandboxSummary> = {}
): SandboxSummary => {
    seq += 1
    return {
        id: `sbx_${seq}`,
        userId: 'usr_1',
        name: `sandbox-${seq}`,
        status: 'ready',
        failureReason: null,
        providerId: 'rtp_1',
        providerName: 'sprites.dev',
        providerRefLabel: `sprite-${seq}`,
        powerState: 'running',
        registered: true,
        daemonOnline: true,
        keepAwake: false,
        terminalEnabled: false,
        terminalModelCredentials: false,
        agentsCount: 0,
        detectedFrameworks: [],
        cliVersion: null,
        latestCliVersion: null,
        cliUpdateAvailable: false,
        herdrVersion: null,
        latestHerdrVersion: null,
        herdrUpdateAvailable: false,
        canOpenInHerdr: false,
        herdrFrameworks: [],
        activeSecondsThisPeriod: 0,
        emptiedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        ...over
    }
}
