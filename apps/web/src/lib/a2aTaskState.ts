import type {
    A2aTaskTraceItem,
    ChatUsage
} from '@manyfold/shared'

export type A2aStateTone = 'info' | 'success' | 'warning' | 'error' | 'idle'

const TERMINAL_STATES = new Set([
    'completed',
    'failed',
    'canceled',
    'rejected'
])

export const isTerminalA2aState = (state: string): boolean =>
    TERMINAL_STATES.has(state)

export const a2aStateTone = (state: string): A2aStateTone => {
    switch (state) {
        case 'completed':
            return 'success'
        case 'failed':
        case 'rejected':
            return 'error'
        case 'working':
        case 'submitted':
            return 'info'
        case 'input-required':
        case 'auth-required':
            return 'warning'
        default:
            return 'idle'
    }
}

export const a2aPeerLabel = (task: A2aTaskTraceItem): string => {
    if (task.direction === 'inbound')
        return (
            task.callerAgentName ??
            (task.externalSubject ? 'external caller' : 'unknown')
        )
    return task.targetAgentName ?? task.targetAgentId
}

export const formatElapsed = (
    startIso: string,
    endIso?: string | null
): string => {
    const start = Date.parse(startIso)
    const end = endIso ? Date.parse(endIso) : Date.now()
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''
    const totalSec = Math.round((end - start) / 1000)
    if (totalSec < 60) return `${totalSec}s`
    const min = Math.floor(totalSec / 60)
    if (min < 60) return `${min}m ${totalSec % 60}s`
    const hr = Math.floor(min / 60)
    return `${hr}h ${min % 60}m`
}

const tokenTotal = (usage: ChatUsage | null): number | null => {
    if (!usage) return null
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    return total > 0 ? total : null
}

export const formatTokens = (usage: ChatUsage | null): string | null => {
    const total = tokenTotal(usage)
    if (total === null) return null
    if (total < 1000) return String(total)
    if (total < 1_000_000) return `${(total / 1000).toFixed(1)}k`
    return `${(total / 1_000_000).toFixed(1)}M`
}