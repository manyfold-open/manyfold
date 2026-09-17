import type { SdkAgent } from '@manyfold/sdk'
import type {
    AgentStorageUsageResponse,
    SandboxUsageBreakdown
} from '@manyfold/shared'

const unsupported = (): Error =>
    new Error(
        'API does not support the current storage contract; upgrade the API before using this command'
    )

export const assertAgentStorageContract = (agent: SdkAgent): void => {
    if (
        !agent ||
        typeof agent !== 'object' ||
        'storageBytes' in agent ||
        'storageMeasuredAt' in agent
    )
        throw unsupported()
    const { workspaceBytes, workspaceMeasuredAt } = agent
    if (workspaceBytes === null && workspaceMeasuredAt === null) return
    if (
        typeof workspaceBytes !== 'number' ||
        !Number.isSafeInteger(workspaceBytes) ||
        workspaceBytes < 0 ||
        typeof workspaceMeasuredAt !== 'string' ||
        !Number.isFinite(Date.parse(workspaceMeasuredAt))
    )
        throw unsupported()
}

export const assertSandboxStorageContract = (
    report: SandboxUsageBreakdown,
    scope: 'account' | 'sandbox'
): void => {
    if (
        !report ||
        report.scope !== scope ||
        report.unit !== 'bytes' ||
        !report.storageFreshness ||
        !Array.isArray(report.hosts)
    )
        throw unsupported()
}

export const assertAgentPathStorageContract = (
    report: AgentStorageUsageResponse
): void => {
    if (
        !report ||
        report.scope !== 'agent-paths' ||
        report.unit !== 'bytes' ||
        !Array.isArray(report.items) ||
        !('cachedSandbox' in report)
    )
        throw unsupported()
}
