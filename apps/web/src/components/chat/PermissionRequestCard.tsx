import type { PermissionConsentPreview } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '@manyfold/sdk'
import {
    CheckIcon,
    ExternalLinkIcon,
    ShieldCheckIcon
} from '@/components/icons'
import ProductDialog from '@/components/ProductDialog'
import PermissionConsent, {
    type PermissionConsentGranted
} from '@/components/permissions/PermissionConsent'
import { Ghost } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { RiskTag } from '@/components/Tag'
import { useChatGrantActions } from '@/components/chat/ChatGrantContext'
import {
    stateFromPreview,
    type CardState
} from '@/components/chat/utils/permissionCardState'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

const buildApprovedText = (result: PermissionConsentGranted): string => {
    const approved = result.approvedScopes.join(', ')
    if (result.deniedScopes.length === 0)
        return `✅ Approved new permissions: ${approved}. Please continue.`
    return `✅ Approved: ${approved}. Not granted: ${result.deniedScopes.join(
        ', '
    )}. Please continue with what was approved.`
}

const buildDeniedText = (scopes: string[]): string =>
    scopes.length > 0
        ? `I declined the permission request (${scopes.join(
              ', '
          )}). Please continue without it or suggest another approach.`
        : 'I declined the permission request. Please continue without it or suggest another approach.'

const PermissionRequestCard: FC<{ token: string }> = ({ token }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const actions = useChatGrantActions()
    const [state, setState] = useState<CardState>({ kind: 'loading' })
    const [dialogOpen, setDialogOpen] = useState(false)
    const [resolving, setResolving] = useState(false)
    const [decisionError, setDecisionError] = useState<string | null>(null)
    const { showLoading, fadeIn } = useLoadingGate(state.kind === 'loading')

    useEffect(() => {
        let cancelled = false
        setState({ kind: 'loading' })
        void client.grants
            .previewRequest(token)
            .then((result) => {
                if (cancelled) return
                setState(stateFromPreview(result))
            })
            .catch((err: unknown) => {
                if (cancelled) return
                if (err instanceof ApiError && err.status >= 500) {
                    // transient — keep the request actionable via the dialog
                    setState({ kind: 'pending', preview: null })
                    return
                }
                setState({ kind: 'unavailable' })
            })
        return () => {
            cancelled = true
        }
    }, [client, token])

    const fallbackHref = `/grant-permission?token=${encodeURIComponent(token)}`

    const handleApproved = (result: PermissionConsentGranted): void => {
        setDialogOpen(false)
        setDecisionError(null)
        setState({
            kind: 'approved',
            agentName: result.agentName,
            count: result.approvedScopes.length
        })
        actions?.continueAfterGrant(buildApprovedText(result))
    }

    const handleDeniedConfirmed = (): void => {
        setDialogOpen(false)
        const scopes =
            state.kind === 'pending'
                ? (state.preview?.scopes.map((s) => s.scope) ?? [])
                : []
        setState({ kind: 'denied' })
        setDecisionError(null)
        actions?.continueAfterGrant(buildDeniedText(scopes))
    }

    const handleResolved = useCallback(
        (preview: PermissionConsentPreview): void => {
            setDialogOpen(false)
            setDecisionError(null)
            setState(stateFromPreview(preview))
        },
        []
    )

    const handleDenied = async (): Promise<void> => {
        if (resolving) return
        setResolving(true)
        setDecisionError(null)
        try {
            await client.grants.denyRequest(token)
            handleDeniedConfirmed()
        } catch (err) {
            console.error('Permission denial failed', err)
            if (err instanceof ApiError && err.status === 410) {
                try {
                    handleResolved(await client.grants.previewRequest(token))
                } catch (reconcileError) {
                    console.error(
                        'Permission resolution refresh failed',
                        reconcileError
                    )
                    setDecisionError(apiErrorDetailMessage(reconcileError))
                }
            } else {
                setDecisionError(apiErrorDetailMessage(err))
            }
        } finally {
            setResolving(false)
        }
    }

    const handleDismiss = (): void => {
        setDialogOpen(false)
    }

    // §10.8: a preview that lands inside the gate shows no indicator at all,
    // and the card must never render its buttons before the server has said
    // whether the request is still open.
    if (state.kind === 'loading' && !showLoading) return null

    if (state.kind === 'unavailable') {
        return (
            <div className='bg-surface-subtle shadow-ring text-ui text-muted my-2 rounded-md p-4'>
                <p>{t('web.permissions.requestUnavailable')}</p>
                <a
                    href={fallbackHref}
                    target='_blank'
                    rel='noreferrer'
                    className='text-link mt-2 inline-flex items-center gap-1 underline'
                >
                    {t('web.permissions.openRequestPage')}
                    <ExternalLinkIcon className='h-3.5 w-3.5' />
                </a>
            </div>
        )
    }

    if (state.kind === 'approved') {
        return (
            <div
                className={
                    fadeIn
                        ? 'border-success/40 bg-success-bg shadow-ring-light text-ui loading-fade-in my-2 rounded-md border px-3.5 py-3'
                        : 'border-success/40 bg-success-bg shadow-ring-light text-ui my-2 rounded-md border px-3.5 py-3'
                }
            >
                <div className='text-fg flex items-center gap-2 font-medium'>
                    <CheckIcon className='text-success h-4 w-4 shrink-0' />
                    {t('web.permissions.granted', {
                        count: state.count,
                        capability: t(
                            state.count === 1
                                ? 'web.permissions.capability'
                                : 'web.permissions.capabilities'
                        ),
                        name: state.agentName
                    })}
                </div>
                <p className='text-muted mt-1'>
                    {t('web.permissions.agentContinuing')}
                </p>
            </div>
        )
    }

    if (state.kind === 'denied') {
        return (
            <div className='bg-surface-subtle shadow-ring text-ui text-muted my-2 rounded-md px-3.5 py-3'>
                {t('web.permissions.declined')}
            </div>
        )
    }

    const loading = state.kind === 'loading'
    const preview = loading ? null : state.preview
    const scopes = preview?.scopes ?? []

    return (
        <div
            className='bg-surface shadow-ring my-2 rounded-md p-4'
            aria-busy={loading || undefined}
        >
            <div className='flex items-start gap-3'>
                <span className='bg-badge-bg text-link rounded-pill flex h-8 w-8 shrink-0 items-center justify-center'>
                    <ShieldCheckIcon className='h-4 w-4' />
                </span>
                <div className='min-w-0 flex-1'>
                    <div className='text-ui text-fg font-medium'>
                        {t('web.permissions.requestTitle')}
                    </div>
                    <p className='text-caption text-muted mt-0.5'>
                        {preview ? (
                            <>
                                <span className='font-mono'>
                                    {preview.agentName}
                                </span>{' '}
                                {t('web.permissions.wantsCapabilities')}
                            </>
                        ) : (
                            t('web.permissions.wantsCapabilitiesGeneric')
                        )}
                    </p>

                    {loading && (
                        <div className='mt-3 flex flex-wrap gap-1.5'>
                            <Ghost variant='cap' className='w-24' />
                            <Ghost variant='cap' className='w-16' />
                        </div>
                    )}

                    {scopes.length > 0 && (
                        <ul className='mt-3 flex flex-wrap gap-1.5'>
                            {scopes.map((scope) => (
                                <li
                                    key={scope.scope}
                                    className='flex items-center gap-1.5'
                                >
                                    <code className='text-caption text-fg bg-surface-subtle shadow-ring-light rounded-xs px-1.5 py-0.5 font-mono'>
                                        {scope.scope}
                                    </code>
                                    <RiskTag danger={scope.danger} />
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className='mt-3 flex flex-wrap gap-2'>
                        <button
                            type='button'
                            className='workbench-button-primary'
                            disabled={loading || resolving}
                            onClick={() => setDialogOpen(true)}
                        >
                            {t('web.permissions.reviewApprove')}
                        </button>
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            disabled={loading || resolving}
                            onClick={() => void handleDenied()}
                        >
                            {t('web.permissions.deny')}
                        </button>
                    </div>
                    {decisionError && (
                        <div className='workbench-alert-error mt-3'>
                            {decisionError}
                        </div>
                    )}
                </div>
            </div>

            {dialogOpen && (
                <ProductDialog
                    title={t('web.permissions.reviewTitle')}
                    description={t('web.permissions.reviewDescription')}
                    size='md'
                    onClose={handleDismiss}
                >
                    <PermissionConsent
                        token={token}
                        onGranted={handleApproved}
                        onDenied={handleDeniedConfirmed}
                        onResolved={handleResolved}
                        onDismiss={handleDismiss}
                    />
                </ProductDialog>
            )}
        </div>
    )
}

export default PermissionRequestCard
