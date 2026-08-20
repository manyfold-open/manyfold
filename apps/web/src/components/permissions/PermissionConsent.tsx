import type {
    GrantableScope,
    PermissionConsentPreview,
    PermissionConsentScope
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '@manyfold/sdk'
import { SheenText } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { RiskTag } from '@/components/Tag'
import { useI18n } from '@/lib/i18n'

export interface PermissionConsentGranted {
    approvedScopes: GrantableScope[]
    deniedScopes: GrantableScope[]
    agentName: string
}

interface Props {
    token: string
    onGranted: (result: PermissionConsentGranted) => void
    // Called only after the refusal has been durably recorded.
    onDenied: () => void
    // Another surface won the approve/deny race. Give the caller the
    // authoritative terminal state so it cannot keep rendering pending UI.
    onResolved?: (preview: PermissionConsentPreview) => void
    onDismiss: () => void
    denyLabel?: string
}

type LoadState =
    | { kind: 'loading' }
    | { kind: 'ready'; preview: PermissionConsentPreview }
    | { kind: 'resolved'; preview: PermissionConsentPreview }
    | { kind: 'expired' }
    | { kind: 'not_found' }
    | { kind: 'error'; message: string }

const isExpiredError = (err: ApiError): boolean =>
    err.status === 410 ||
    err.code === 'gone' ||
    err.code.includes('expired') ||
    err.code.includes('invalid')

const PermissionConsent: FC<Props> = ({
    token,
    onGranted,
    onDenied,
    onResolved,
    onDismiss,
    denyLabel
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [decision, setDecision] = useState<'approve' | 'deny' | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!token) {
            setLoad({ kind: 'not_found' })
            return
        }
        let cancelled = false
        void client.grants
            .previewRequest(token)
            .then((preview) => {
                if (cancelled) return
                // Already answered — by another tab, an earlier click, or the
                // owner on another device. Never re-offer it.
                if (preview.status !== 'pending') {
                    setLoad({ kind: 'resolved', preview })
                    onResolved?.(preview)
                    return
                }
                setLoad({ kind: 'ready', preview })
                // High-danger scopes must start UNCHECKED — the owner has to
                // explicitly opt in. Low/medium may start checked.
                const initiallyChecked = preview.scopes
                    .filter((s) => s.danger !== 'high')
                    .map((s) => s.scope)
                setSelected(new Set(initiallyChecked))
            })
            .catch((err: unknown) => {
                if (cancelled) return
                if (err instanceof ApiError) {
                    if (err.status === 404) {
                        setLoad({ kind: 'not_found' })
                        return
                    }
                    if (isExpiredError(err)) {
                        setLoad({ kind: 'expired' })
                        return
                    }
                }
                setLoad({ kind: 'error', message: apiErrorDetailMessage(err) })
            })
        return () => {
            cancelled = true
        }
    }, [client, onResolved, token])

    const preview = load.kind === 'ready' ? load.preview : null

    const orderedScopes = useMemo<PermissionConsentScope[]>(() => {
        if (!preview) return []
        const rank: Record<PermissionConsentScope['danger'], number> = {
            high: 0,
            medium: 1,
            low: 2
        }
        return [...preview.scopes].sort(
            (a, b) => rank[a.danger] - rank[b.danger]
        )
    }, [preview])

    const toggleScope = (scope: string, next: boolean): void => {
        setSelected((prev) => {
            const ns = new Set(prev)
            if (next) ns.add(scope)
            else ns.delete(scope)
            return ns
        })
    }

    const reconcileResolution = async (): Promise<void> => {
        const latest = await client.grants.previewRequest(token)
        if (latest.status === 'pending')
            throw new Error('permission request is unexpectedly still pending')
        setLoad({ kind: 'resolved', preview: latest })
        onResolved?.(latest)
    }

    const doApprove = async (): Promise<void> => {
        if (!preview) return
        const approvedScopes = preview.scopes
            .map((s) => s.scope)
            .filter((scope) => selected.has(scope))
        if (approvedScopes.length === 0) {
            setError(t('web.permissions.selectCapability'))
            return
        }
        setDecision('approve')
        setError(null)
        try {
            await client.grants.grantRequest({ token, approvedScopes })
            const approved = new Set<GrantableScope>(approvedScopes)
            const deniedScopes = preview.scopes
                .map((s) => s.scope)
                .filter((scope) => !approved.has(scope))
            onGranted({
                approvedScopes,
                deniedScopes,
                agentName: preview.agentName
            })
        } catch (err) {
            console.error('Permission grant failed', err)
            // 410 — something else claimed the request between preview and
            // submit. Re-fetch the winning decision instead of guessing it.
            if (err instanceof ApiError && err.status === 410) {
                try {
                    await reconcileResolution()
                } catch (reconcileError) {
                    console.error(
                        'Permission resolution refresh failed',
                        reconcileError
                    )
                    setError(apiErrorDetailMessage(reconcileError))
                    setDecision(null)
                }
                return
            }
            setError(apiErrorDetailMessage(err))
            setDecision(null)
        }
    }

    const doDeny = async (): Promise<void> => {
        setDecision('deny')
        setError(null)
        try {
            await client.grants.denyRequest(token)
            onDenied()
        } catch (err) {
            console.error('Permission denial failed', err)
            if (err instanceof ApiError && err.status === 410) {
                try {
                    await reconcileResolution()
                } catch (reconcileError) {
                    console.error(
                        'Permission resolution refresh failed',
                        reconcileError
                    )
                    setError(apiErrorDetailMessage(reconcileError))
                    setDecision(null)
                }
                return
            }
            setError(apiErrorDetailMessage(err))
            setDecision(null)
        }
    }

    if (load.kind === 'loading') {
        return (
            <SheenText className='text-muted text-ui'>
                {t('web.permissions.loadingRequest')}
            </SheenText>
        )
    }

    if (load.kind === 'resolved') {
        const count = load.preview.approvedScopes.length
        return (
            <>
                <div className='bg-surface-subtle shadow-ring-light text-ui rounded-md px-3.5 py-3'>
                    {load.preview.status === 'approved'
                        ? t('web.permissions.granted', {
                              count,
                              capability: t(
                                  count === 1
                                      ? 'web.permissions.capability'
                                      : 'web.permissions.capabilities'
                              ),
                              name: load.preview.agentName
                          })
                        : t('web.permissions.declined')}
                </div>
                <DismissButton
                    label={t('web.permissions.close')}
                    onClick={onDismiss}
                />
            </>
        )
    }

    if (load.kind === 'expired') {
        return (
            <>
                <div className='workbench-alert-error'>
                    {t('web.permissions.requestExpired')}
                </div>
                <DismissButton
                    label={t('web.permissions.close')}
                    onClick={onDismiss}
                />
            </>
        )
    }

    if (load.kind === 'not_found') {
        return (
            <>
                <div className='workbench-alert-error'>
                    {t('web.permissions.requestNotFound')}
                </div>
                <DismissButton
                    label={t('web.permissions.close')}
                    onClick={onDismiss}
                />
            </>
        )
    }

    if (load.kind === 'error') {
        return (
            <>
                <div className='workbench-alert-error'>{load.message}</div>
                <DismissButton
                    label={t('web.permissions.close')}
                    onClick={onDismiss}
                />
            </>
        )
    }

    return (
        <div className='space-y-5'>
            <div>
                <div className='workbench-field-label'>
                    {t('web.permissions.requestingAgent')}
                </div>
                <div className='text-fg text-ui font-mono'>
                    {load.preview.agentName}
                </div>
            </div>

            <div>
                <div className='workbench-field-label mb-2'>
                    {t('web.permissions.capabilitiesRequested')}
                </div>
                <p className='text-caption text-subtle mb-3'>
                    {t('web.permissions.capabilitiesHint')}
                </p>
                <ul className='space-y-2'>
                    {orderedScopes.map((meta) => {
                        const isSelected = selected.has(meta.scope)
                        const isHigh = meta.danger === 'high'
                        return (
                            <li
                                key={meta.scope}
                                className={[
                                    'border-divider bg-surface rounded-md border px-3.5 py-3 transition-shadow',
                                    isHigh && isSelected
                                        ? 'ring-workflow-ship/40 ring-2'
                                        : ''
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                <label className='flex cursor-pointer items-start gap-3'>
                                    <input
                                        type='checkbox'
                                        className='border-divider text-fg focus-visible:ring-focus mt-0.5 h-4 w-4 rounded'
                                        checked={isSelected}
                                        disabled={decision !== null}
                                        onChange={(event) =>
                                            toggleScope(
                                                meta.scope,
                                                event.target.checked
                                            )
                                        }
                                        aria-describedby={`scope-${meta.scope}-summary`}
                                    />
                                    <span className='min-w-0 flex-1'>
                                        <span className='flex flex-wrap items-center gap-2'>
                                            <code className='text-ui text-fg font-mono'>
                                                {meta.scope}
                                            </code>
                                            <RiskTag danger={meta.danger} />
                                        </span>
                                        <span
                                            id={`scope-${meta.scope}-summary`}
                                            className='text-ui text-muted mt-1 block'
                                        >
                                            {meta.summary}
                                        </span>
                                    </span>
                                </label>
                            </li>
                        )
                    })}
                </ul>
            </div>

            <div className='flex flex-wrap gap-2'>
                <button
                    type='button'
                    className='workbench-button-primary'
                    disabled={decision !== null || selected.size === 0}
                    onClick={() => void doApprove()}
                >
                    {decision === 'approve'
                        ? t('web.permissions.granting')
                        : t('web.permissions.approve')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    disabled={decision !== null}
                    onClick={() => void doDeny()}
                >
                    {denyLabel ?? t('web.permissions.deny')}
                </button>
            </div>

            {error && <div className='workbench-alert-error'>{error}</div>}
        </div>
    )
}

const DismissButton: FC<{ label: string; onClick: () => void }> = ({
    label,
    onClick
}): ReactNode => (
    <button
        type='button'
        className='workbench-button-secondary'
        onClick={onClick}
    >
        {label}
    </button>
)

export default PermissionConsent
