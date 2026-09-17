import type { AgentStorageBreakdown } from '@manyfold/db'

// Legacy meters stored whole-VM bytes in agents.storageBytes. Their breakdown
// kept the independent du value, but also converted a missing section to zero.
export const workspaceReading = (agent: {
    storageMeasuredAt: Date | null
    storageBreakdown: Pick<
        AgentStorageBreakdown,
        'workspaceBytes' | 'measuredVia' | 'formatVersion'
    > | null
}): { workspaceBytes: number | null; workspaceMeasuredAt: string | null } => {
    const breakdown = agent.storageBreakdown
    const value = breakdown?.workspaceBytes
    const measuredAt = agent.storageMeasuredAt
    if (
        !breakdown ||
        !measuredAt ||
        Number.isNaN(measuredAt.getTime()) ||
        (breakdown.measuredVia !== 'df' && breakdown.measuredVia !== 'du') ||
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        (value === 0 && breakdown.formatVersion !== 1)
    )
        return { workspaceBytes: null, workspaceMeasuredAt: null }
    return {
        workspaceBytes: value,
        workspaceMeasuredAt: measuredAt.toISOString()
    }
}
