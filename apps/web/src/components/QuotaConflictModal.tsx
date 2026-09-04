import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { BILLING_SURFACE } from '@/edition-capabilities'

export type QuotaConflictRetry = () => Promise<void>

// Stop-another-agent flow: freeing a concurrent slot unblocks the start.
export interface ConcurrentQuotaConflictRequest {
    kind: 'concurrent'
    newAgentId: string
    newAgentName: string
    runningAgents: SdkAgent[]
    onRetry: QuotaConflictRetry
    onCancel?: () => void
}

// Period/plan quotas (active hours, storage): nothing to stop — the only
// self-serve remedy is upgrading, so the dialog routes to pricing.
export interface UpgradeQuotaConflictRequest {
    kind: 'upgrade'
    code: string
    message: string
    onCancel?: () => void
}

export type QuotaConflictRequest =
    | ConcurrentQuotaConflictRequest
    | UpgradeQuotaConflictRequest

interface Props {
    request: QuotaConflictRequest | null
    onClose: () => void
}

const UpgradeQuotaDialog: FC<{
    request: UpgradeQuotaConflictRequest
    onClose: () => void
}> = ({ request, onClose }) => {
    const { t } = useI18n()
    const navigate = useNavigate()
    const dismiss = (): void => {
        request.onCancel?.()
        onClose()
    }
    return createPortal(
        <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='quota-conflict-title'
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4'
            onClick={(e) => {
                if (e.target === e.currentTarget) dismiss()
            }}
        >
            <div className='bg-surface-elevated shadow-elevated rounded-md w-full max-w-lg p-6'>
                <h2
                    id='quota-conflict-title'
                    className='text-h2 text-fg mb-2'
                >
                    {request.code === 'ACTIVE_HOURS_QUOTA_REACHED'
                        ? t('web.quotaConflict.activeHoursUsed')
                        : request.code === 'STORAGE_LIMIT_REACHED'
                          ? t('web.quotaConflict.storageLimit')
                          : t('web.quotaConflict.planLimit')}
                </h2>
                <p className='text-ui text-muted mb-4'>{request.message}</p>
                <div className='flex justify-end gap-2'>
                    <button
                        type='button'
                        onClick={dismiss}
                        className='workbench-button-secondary'
                    >
                        {t('web.quotaConflict.close')}
                    </button>
                    {BILLING_SURFACE && (
                        <button
                            type='button'
                            onClick={() => {
                                dismiss()
                                navigate('/settings/plan-and-billing/pricing')
                            }}
                            className='workbench-button-primary'
                        >
                            {t('web.quotaConflict.viewPlans')}
                        </button>
                    )}
                </div>
            </div>
        </div>,
        document.body
    )
}

const STOP_TIMEOUT_MS = 45_000
const POLL_INTERVAL_MS = 1_000

const QuotaConflictModal: FC<Props> = ({ request, onClose }) => {
    const { t } = useI18n()
    const client = useApiClient()
    const [error, setError] = useState<string | null>(null)
    const [phase, setPhase] = useState<
        'idle' | 'stopping' | 'starting' | 'done'
    >('idle')
    const [activeStopId, setActiveStopId] = useState<string | null>(null)
    const cancelledRef = useRef(false)

    useEffect(() => {
        cancelledRef.current = false
        setError(null)
        setPhase('idle')
        setActiveStopId(null)
        return () => {
            cancelledRef.current = true
        }
    }, [request])

    const stopAgentIsRunning = useMemo(() => {
        if (!request || request.kind !== 'concurrent')
            return new Map<string, boolean>()
        const map = new Map<string, boolean>()
        for (const a of request.runningAgents) {
            map.set(a.id, a.spriteStatus === 'running')
        }
        return map
    }, [request])

    const handleStopAndStart = useCallback(
        async (stopAgent: SdkAgent): Promise<void> => {
            if (!request || request.kind !== 'concurrent') return
            cancelledRef.current = false
            setError(null)
            setActiveStopId(stopAgent.id)
            setPhase('stopping')
            try {
                await client.agents.stop(stopAgent.id)
                const deadline = Date.now() + STOP_TIMEOUT_MS
                while (Date.now() < deadline) {
                    if (cancelledRef.current) return
                    const fresh = await client.agents.get(stopAgent.id)
                    if (fresh.spriteStatus !== 'running') break
                    await new Promise((resolve) =>
                        setTimeout(resolve, POLL_INTERVAL_MS)
                    )
                }
                const fresh = await client.agents.get(stopAgent.id)
                if (fresh.spriteStatus === 'running') {
                    setError(
                        t('web.quotaConflict.stopTimeout', {
                            name: stopAgent.name
                        })
                    )
                    setPhase('idle')
                    setActiveStopId(null)
                    return
                }
                if (cancelledRef.current) return
                setPhase('starting')
                await request.onRetry()
                if (!cancelledRef.current) {
                    setPhase('done')
                    onClose()
                }
            } catch (err) {
                setError((err as Error).message)
                setPhase('idle')
                setActiveStopId(null)
            }
        },
        [client, onClose, request, t]
    )

    if (!request) return null
    if (request.kind === 'upgrade')
        return <UpgradeQuotaDialog request={request} onClose={onClose} />
    const busy = phase === 'stopping' || phase === 'starting'
    const runningAgents = request.runningAgents.filter(
        (a) => a.spriteStatus === 'running'
    )

    return createPortal(
        <div
            role='dialog'
            aria-modal='true'
            aria-labelledby='quota-conflict-title'
            className='fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4'
            onClick={(e) => {
                if (e.target === e.currentTarget && !busy) {
                    request.onCancel?.()
                    onClose()
                }
            }}
        >
            <div className='bg-surface-elevated shadow-elevated rounded-md w-full max-w-lg p-6'>
                <h2
                    id='quota-conflict-title'
                    className='text-h2 text-fg mb-2'
                >
                    {t('web.quotaConflict.concurrentTitle')}
                </h2>
                <p className='text-ui text-muted mb-4'>
                    {t('web.quotaConflict.concurrentBody', {
                        name: request.newAgentName
                    })}
                </p>
                {error && (
                    <div className='workbench-alert-error mb-4'>{error}</div>
                )}
                <div className='flex flex-col gap-2 mb-4'>
                    {runningAgents.length === 0 && (
                        <div className='workbench-note'>
                            {t('web.quotaConflict.noRunningAgents')}
                        </div>
                    )}
                    {runningAgents.map((a) => {
                        const isActive = activeStopId === a.id
                        const stillRunning = stopAgentIsRunning.get(a.id)
                        return (
                            <div
                                key={a.id}
                                className='flex items-center justify-between gap-3 rounded-md bg-surface px-3 py-2 shadow-ring-light'
                            >
                                <div className='min-w-0'>
                                    <div className='text-ui text-fg truncate font-medium'>
                                        {a.name}
                                    </div>
                                    <div className='text-caption text-subtle truncate font-mono'>
                                        {a.id}
                                    </div>
                                </div>
                                <button
                                    type='button'
                                    disabled={busy || stillRunning === false}
                                    onClick={() => {
                                        void handleStopAndStart(a)
                                    }}
                                    className='workbench-button-primary whitespace-nowrap'
                                >
                                    {isActive && phase === 'stopping'
                                        ? t('web.quotaConflict.stopping', {
                                              name: a.name
                                          })
                                        : isActive && phase === 'starting'
                                          ? t('web.quotaConflict.starting', {
                                                name: request.newAgentName
                                            })
                                          : t('web.quotaConflict.stopAndStart')}
                                </button>
                            </div>
                        )
                    })}
                </div>
                <div className='flex justify-end gap-2'>
                    <button
                        type='button'
                        onClick={() => {
                            cancelledRef.current = true
                            request.onCancel?.()
                            onClose()
                        }}
                        className='workbench-button-secondary'
                    >
                        {busy ? t('common.cancel') : t('web.quotaConflict.close')}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default QuotaConflictModal
