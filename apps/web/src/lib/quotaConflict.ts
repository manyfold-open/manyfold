import { ApiError } from '@manyfold/sdk'
import type { SdkAgent } from '@manyfold/sdk'
import { apiErrorMessage } from '@/lib/errorMessage'
import type {
    QuotaConflictRequest,
    QuotaConflictRetry
} from '@/components/QuotaConflictModal'

export const isConcurrentLimitReached = (err: unknown): boolean =>
    err instanceof ApiError && err.code === 'CONCURRENT_ACTIVE_LIMIT_REACHED'

const UPGRADE_QUOTA_CODES = new Set([
    'ACTIVE_HOURS_QUOTA_REACHED',
    'STORAGE_LIMIT_REACHED'
])

export const isUpgradeQuotaReached = (err: unknown): boolean =>
    err instanceof ApiError &&
    typeof err.code === 'string' &&
    UPGRADE_QUOTA_CODES.has(err.code)

export interface BuildQuotaConflictInput {
    err: unknown
    newAgent: { id: string; name: string }
    candidates: SdkAgent[]
    retry: QuotaConflictRetry
    onCancel?: () => void
}

export const buildQuotaConflictRequest = (
    input: BuildQuotaConflictInput
): QuotaConflictRequest | null => {
    if (isUpgradeQuotaReached(input.err)) {
        const err = input.err as ApiError
        return {
            kind: 'upgrade',
            code: err.code as string,
            message: apiErrorMessage(err),
            onCancel: input.onCancel
        }
    }
    if (!isConcurrentLimitReached(input.err)) return null
    const runningAgents = input.candidates.filter(
        (a) => a.id !== input.newAgent.id && a.spriteStatus === 'running'
    )
    return {
        kind: 'concurrent',
        newAgentId: input.newAgent.id,
        newAgentName: input.newAgent.name,
        runningAgents,
        onRetry: input.retry,
        onCancel: input.onCancel
    }
}
