import { Suspense, useCallback, useEffect, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type {
    AgentRuntimeSummary,
    RuntimeAccountUsageWindow,
    RuntimeAccountView
} from '@manyfold/shared'
import { Link } from 'react-router-dom'
import { GhostSettingsRows, Spinner } from '@/components/Loading'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { NoticeRow, relative, Section } from '@/components/RuntimeDetailPanel'
import { StatusTag, Tag, type TagTone } from '@/components/Tag'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n, type TFn } from '@/lib/i18n'
import { lazyChunk } from '@/lib/lazyChunk'
import {
    formatResetsIn,
    planLabel,
    signInNeeded,
    usageTone,
    usageWindowLabelKey
} from '@/lib/runtimeAccount'
import { updatesPath } from '@/lib/updateCenter'
import { formatDuration } from '@/lib/usageFormat'

const RuntimeSignInTerminal = lazyChunk(
    () => import('@/components/RuntimeSignInTerminal')
)

// Literal class names on purpose: Tailwind only emits utilities it can see
// verbatim in the source (the Tag.tsx precedent).
const BAR_TONE: Record<TagTone, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

const credentialTag = (
    view: RuntimeAccountView,
    t: TFn
): { tone: TagTone; label: string } => {
    if (view.credentialStatus === 'valid')
        return view.credentialReason === 'api-key' ||
            view.credentialReason === 'env-token'
            ? { tone: 'info', label: t('web.runtimeDetails.account.apiKey') }
            : {
                  tone: 'success',
                  label: t('web.runtimeDetails.account.signedIn')
              }
    if (view.credentialStatus === 'expired')
        return { tone: 'warning', label: t('web.runtimeDetails.account.expired') }
    if (view.credentialStatus === 'missing')
        return {
            tone: 'error',
            label: t('web.runtimeDetails.account.notSignedIn')
        }
    return { tone: 'idle', label: t('web.runtimeDetails.account.unknownStatus') }
}

// One line under the bars explaining why usage is thin or absent. Silent
// when the usage simply loaded.
const usageNote = (view: RuntimeAccountView, t: TFn): string | null => {
    const error = view.usage?.error
    if (error) {
        if (error.kind === 'stale-token')
            return t('web.runtimeDetails.account.usageStale')
        if (error.kind === 'unauthorized')
            return t('web.runtimeDetails.account.usageUnauthorized')
        if (error.kind === 'rate-limited')
            return t('web.runtimeDetails.account.usageRateLimited', {
                time: error.retryAfterSeconds
                    ? formatDuration(error.retryAfterSeconds * 1000)
                    : '—'
            })
        if (error.kind === 'network')
            return t('web.runtimeDetails.account.usageNetwork')
        return error.message
            ? `${t('web.runtimeDetails.account.usageUnexpected')} (${error.message})`
            : t('web.runtimeDetails.account.usageUnexpected')
    }
    if (view.usage) return null
    if (view.tokenSource === 'keychain-unread')
        return t('web.runtimeDetails.account.keychainUnread')
    if (
        view.credentialStatus === 'valid' &&
        (view.credentialReason === 'api-key' ||
            view.credentialReason === 'env-token')
    )
        return t('web.runtimeDetails.account.usageApiKey')
    return null
}

const UsageWindowRow: FC<{ window: RuntimeAccountUsageWindow; now: number }> = ({
    window,
    now
}): ReactNode => {
    const { t } = useI18n()
    const labelKey = usageWindowLabelKey(window.key)
    const label = labelKey ? t(labelKey) : window.key
    const tone = usageTone(window.usedPercent)
    const resetsIn = formatResetsIn(window.resetsAt, now)
    return (
        <div className='settings-card-row'>
            <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
                    <span className='settings-card-label'>{label}</span>
                    <span className='text-caption text-muted tabular-nums'>
                        {`${window.usedPercent}%`}
                        {resetsIn && (
                            <span className='text-subtle'>
                                {' · '}
                                {t('web.runtimeDetails.account.resetsIn', {
                                    time: resetsIn
                                })}
                            </span>
                        )}
                    </span>
                </div>
                <div
                    role='progressbar'
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={window.usedPercent}
                    className='bg-surface-subtle rounded-pill mt-2 h-1.5 w-full overflow-hidden'
                >
                    <div
                        className={['rounded-pill h-full', BAR_TONE[tone]].join(
                            ' '
                        )}
                        style={{ width: `${window.usedPercent}%` }}
                    />
                </div>
            </div>
        </div>
    )
}

// The runtime page's Account section: who the runtime's CLI is signed in as,
// what that account has used, and — when nothing usable is signed in — a
// shell on the host to sign in from. Opening the page reads a host that is
// awake; Refresh (and a sign-in) is the user's explicit consent to wake a
// sleeping sandbox.
const RuntimeAccountSection: FC<{ runtime: AgentRuntimeSummary }> = ({
    runtime
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [view, setView] = useState<RuntimeAccountView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [enablingTerminal, setEnablingTerminal] = useState(false)
    const [signingIn, setSigningIn] = useState(false)
    const runtimeId = runtime.id

    const probe = useCallback(
        async (wake: boolean): Promise<void> => {
            setLoading(true)
            setError(null)
            try {
                setView(await client.agentRuntimes.getAccount(runtimeId, { wake }))
            } catch (e) {
                setError(apiErrorMessage(e))
            } finally {
                setLoading(false)
            }
        },
        [client, runtimeId]
    )

    useEffect(() => {
        void probe(false)
    }, [probe])

    const handleSignIn = async (): Promise<void> => {
        if (!view) return
        if (
            runtime.kind === 'sprites' &&
            runtime.hostId &&
            view.host &&
            !view.host.terminalEnabled
        ) {
            if (
                !(await confirm({
                    title: t('web.terminal.enablePromptTitle'),
                    description: t('web.terminal.enablePromptBody'),
                    confirmLabel: t('web.terminal.enablePromptConfirm')
                }))
            )
                return
            setEnablingTerminal(true)
            setError(null)
            try {
                await client.sandboxes.setTerminal(runtime.hostId, true)
                setView((prev) =>
                    prev?.host
                        ? { ...prev, host: { ...prev.host, terminalEnabled: true } }
                        : prev
                )
            } catch (e) {
                setError(apiErrorMessage(e))
                return
            } finally {
                setEnablingTerminal(false)
            }
        }
        setSigningIn(true)
    }

    const handleSignInDone = (): void => {
        setSigningIn(false)
        void probe(true)
    }

    const renderBody = (): ReactNode => {
        if (!view)
            return loading ? (
                <div className='settings-card' aria-busy='true'>
                    <GhostSettingsRows rows={2} action={false} />
                </div>
            ) : null
        if (view.status === 'unsupported') return null
        if (view.status === 'sandbox-asleep')
            return (
                <NoticeRow
                    title={t('web.runtimeDetails.account.sandboxAsleep')}
                    action={
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            disabled={loading}
                            onClick={(): void => {
                                void probe(true)
                            }}
                        >
                            {loading && <Spinner size={12} />}
                            {t('web.runtimeDetails.account.checkNow')}
                        </button>
                    }
                />
            )
        if (view.status === 'daemon-offline')
            return (
                <NoticeRow
                    tone='danger'
                    title={t('web.runtimeDetails.account.daemonOffline')}
                />
            )
        if (view.status === 'daemon-upgrade-required')
            return (
                <NoticeRow
                    title={t('web.runtimeDetails.account.daemonUpgradeRequired')}
                    action={
                        <Link
                            to={updatesPath('cli')}
                            className='workbench-button-secondary'
                        >
                            {t('web.updates.reviewCta')}
                        </Link>
                    }
                />
            )
        if (view.status === 'probe-failed')
            return (
                <NoticeRow
                    tone='danger'
                    title={t('web.runtimeDetails.account.probeFailed')}
                    detail={view.error}
                />
            )
        const tag = credentialTag(view, t)
        const identity = view.identity
        const plan = planLabel(identity?.plan ?? view.usage?.plan ?? null)
        const headline =
            identity?.email ??
            identity?.name ??
            t('web.runtimeDetails.account.noIdentity')
        const subline = [
            identity?.email ? identity.name : null,
            identity?.organization
        ]
            .filter((part): part is string => Boolean(part))
            .join(' · ')
        const note = usageNote(view, t)
        const now = Date.now()
        return (
            <div className='space-y-3'>
                <div className='settings-card'>
                    <div className='settings-card-row'>
                        <div className='min-w-0'>
                            <div className='settings-card-label break-all'>
                                {headline}
                            </div>
                            <div className='settings-card-copy'>
                                {subline && <span>{subline}</span>}
                                {subline && view.checkedAt && (
                                    <span className='text-subtle'> · </span>
                                )}
                                {view.checkedAt && (
                                    <span>
                                        {t('web.runtimeDetails.checked', {
                                            time: relative(view.checkedAt)
                                        })}
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className='settings-card-side'>
                            {plan && <Tag>{plan}</Tag>}
                            <StatusTag tone={tag.tone} label={tag.label} />
                        </div>
                    </div>
                    {view.usage?.windows.map((window) => (
                        <UsageWindowRow
                            key={window.key}
                            window={window}
                            now={now}
                        />
                    ))}
                    {note && (
                        <div className='settings-card-row'>
                            <p className='text-caption text-muted'>{note}</p>
                        </div>
                    )}
                </div>
                {signInNeeded(view) && !signingIn && (
                    <NoticeRow
                        title={t('web.chat.runtimeSignIn.title')}
                        detail={t('web.runtimeDetails.account.signInHint')}
                        action={
                            <button
                                type='button'
                                className='workbench-button-primary'
                                disabled={enablingTerminal}
                                onClick={(): void => {
                                    void handleSignIn()
                                }}
                            >
                                {enablingTerminal && <Spinner size={12} />}
                                {t('web.runtimeDetails.account.signIn')}
                            </button>
                        }
                    />
                )}
                {signingIn && (
                    <Suspense
                        fallback={
                            <div className='text-caption text-muted flex items-center gap-2 py-4'>
                                <Spinner size={12} />
                                {t('common.loading')}
                            </div>
                        }
                    >
                        <RuntimeSignInTerminal
                            runtimeId={runtime.id}
                            framework={runtime.framework}
                            onDone={handleSignInDone}
                        />
                    </Suspense>
                )}
            </div>
        )
    }

    return (
        <Section
            title={t('web.runtimeDetails.account.title')}
            action={
                <button
                    type='button'
                    className='text-caption text-link hover:text-fg disabled:text-muted font-medium disabled:cursor-not-allowed'
                    disabled={loading}
                    onClick={(): void => {
                        void probe(true)
                    }}
                >
                    {loading
                        ? t('web.chat.runtimeSignIn.checking')
                        : t('web.runtimeDetails.refresh')}
                </button>
            }
        >
            {confirmDialog}
            {error && <div className='workbench-alert-error mb-3'>{error}</div>}
            {renderBody()}
        </Section>
    )
}

export default RuntimeAccountSection
