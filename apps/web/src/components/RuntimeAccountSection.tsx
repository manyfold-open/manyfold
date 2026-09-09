import { Suspense, useCallback, useEffect, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type {
    AgentRuntimeSummary,
    RuntimeAccountUsageWindow,
    RuntimeAccountView,
    RuntimeAuthListView,
    RuntimeAuthOperationView,
    RuntimeAuthProfileView
} from '@manyfold/shared'
import { Link } from 'react-router-dom'
import { GhostSettingsRows, Spinner } from '@/components/Loading'
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { NoticeRow, relative, Section } from '@/components/RuntimeDetailPanel'
import { StatusTag, Tag, type TagTone } from '@/components/Tag'
import { CheckIcon } from '@/components/icons'
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
import {
    profileDisplayName,
    profileNeedsSignIn,
    profileStatusTag
} from '@/lib/runtimeAuth'
import { updatesPath } from '@/lib/updateCenter'
import { formatDuration } from '@/lib/usageFormat'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'

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
        return {
            tone: 'warning',
            label: t('web.runtimeDetails.account.expired')
        }
    if (view.credentialStatus === 'missing')
        return {
            tone: 'error',
            label: t('web.runtimeDetails.account.notSignedIn')
        }
    return {
        tone: 'idle',
        label: t('web.runtimeDetails.account.unknownStatus')
    }
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

const UsageWindowRow: FC<{
    window: RuntimeAccountUsageWindow
    now: number
}> = ({ window, now }): ReactNode => {
    const { t } = useI18n()
    const labelKey = usageWindowLabelKey(window.key)
    const label = [labelKey ? t(labelKey) : window.key, window.scope]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
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

// The account's login/logout/remove all run as operations the host journals;
// the API settles the ones this page started when the shell closes, but that
// settlement races the page's own reload, so wait for it to leave the
// running states before reading the list back.
// Measured on a local daemon [2026-09-09]: the post-close reconcile takes one
// auth.operation + one auth.inspect round trip, well under a second.
const SETTLE_POLL_MS = 500
const SETTLE_POLL_LIMIT = 20

const operationSettled = (op: RuntimeAuthOperationView): boolean =>
    op.status !== 'pending' && op.status !== 'running'

const ProfileRow: FC<{
    profile: RuntimeAuthProfileView
    busy: boolean
    onSignIn: () => void
    onSignOut: () => void
    onRemove: () => void
    onSetDefault: (profileId: string | null) => void
}> = ({
    profile,
    busy,
    onSignIn,
    onSignOut,
    onRemove,
    onSetDefault
}): ReactNode => {
    const { t } = useI18n()
    const tag = profileStatusTag(profile, t)
    const headline = profileDisplayName(profile)
    const plan = planLabel(profile.identity?.plan ?? null)
    const subline = [
        headline !== profile.label ? profile.label : null,
        profile.identity?.organization,
        profile.agentCount > 0
            ? t('web.runtimeAuth.usedBy', { count: profile.agentCount })
            : null,
        profile.checkedAt
            ? t('web.runtimeDetails.checked', {
                  time: relative(profile.checkedAt)
              })
            : null
    ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    const removable = profile.lifecycle !== 'deleting'
    const items: OverflowMenuEntry[] = [
        {
            label: t('web.runtimeDetails.account.signIn'),
            onSelect: onSignIn,
            disabled: busy || !removable
        },
        profile.isDefault
            ? {
                  label: t('web.runtimeAuth.clearDefault'),
                  onSelect: () => onSetDefault(null),
                  disabled: busy
              }
            : {
                  label: t('web.runtimeAuth.makeDefault'),
                  onSelect: () => onSetDefault(profile.id),
                  disabled: busy || !removable
              },
        { separator: true },
        {
            label: t('web.runtimeAuth.signOut'),
            onSelect: onSignOut,
            disabled: busy || !removable || profileNeedsSignIn(profile)
        },
        {
            label: t('web.runtimeAuth.remove'),
            onSelect: onRemove,
            danger: true,
            disabled: busy || !removable || profile.agentCount > 0,
            disabledReason:
                profile.agentCount > 0
                    ? t('web.runtimeAuth.removeBlocked', {
                          count: profile.agentCount
                      })
                    : undefined
        }
    ]
    return (
        <div className='settings-card-row'>
            <div className='min-w-0'>
                <div className='settings-card-label break-all'>{headline}</div>
                {subline && <div className='settings-card-copy'>{subline}</div>}
            </div>
            <div className='settings-card-side'>
                {profile.isDefault && (
                    <span className='text-caption text-link inline-flex items-center gap-1 font-medium'>
                        {t('web.runtimeAuth.defaultForNewAgents')}
                        <CheckIcon className='h-3.5 w-3.5' />
                    </span>
                )}
                {plan && <Tag>{plan}</Tag>}
                <StatusTag tone={tag.tone} label={tag.label} />
                {busy ? (
                    <Spinner size={12} />
                ) : (
                    <OverflowMenu ariaLabel={headline} compact items={items} />
                )}
            </div>
        </div>
    )
}

interface SignInTarget {
    operationId?: string
}

// The runtime page's Account section: who the runtime's CLI is signed in as
// (the host sign-in), what that account has used, the extra accounts added
// on this runtime for agents to run under, and — when a sign-in is needed —
// a shell on the host to do it from. Opening the page reads a host that is
// awake; Refresh (and any sign-in) is the user's explicit consent to wake a
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
    const [signIn, setSignIn] = useState<SignInTarget | null>(null)
    const [busyProfile, setBusyProfile] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const runtimeId = runtime.id
    const {
        list: auth,
        loading: authLoading,
        error: authError,
        reload: reloadAuth
    } = useRuntimeAuthList(runtimeId)

    const probe = useCallback(
        async (wake: boolean): Promise<void> => {
            setLoading(true)
            setError(null)
            try {
                setView(
                    await client.agentRuntimes.getAccount(runtimeId, { wake })
                )
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

    const refreshAll = useCallback(
        async (wake: boolean): Promise<void> => {
            await probe(wake)
            await reloadAuth()
        },
        [probe, reloadAuth]
    )

    const settleOperation = async (
        operationId: string
    ): Promise<RuntimeAuthOperationView | null> => {
        let last: RuntimeAuthOperationView | null = null
        for (let i = 0; i < SETTLE_POLL_LIMIT; i += 1) {
            try {
                last = await client.runtimeAuth.operation(operationId)
            } catch (e) {
                setError(apiErrorMessage(e))
                return null
            }
            if (operationSettled(last)) return last
            await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
        }
        return last
    }

    const reportOperation = (
        op: RuntimeAuthOperationView | null,
        failureKey: 'web.runtimeAuth.signInFailed' | null
    ): void => {
        if (!op || op.status !== 'failed') return
        const reason = op.error ?? op.resultCode ?? op.status
        setError(failureKey ? t(failureKey, { reason }) : reason)
    }

    const handleHostSignIn = async (): Promise<void> => {
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
                        ? {
                              ...prev,
                              host: { ...prev.host, terminalEnabled: true }
                          }
                        : prev
                )
            } catch (e) {
                setError(apiErrorMessage(e))
                return
            } finally {
                setEnablingTerminal(false)
            }
        }
        setSignIn({})
    }

    const startProfileSignIn = async (profileId: string): Promise<void> => {
        setBusyProfile(profileId)
        setError(null)
        try {
            const op = await client.runtimeAuth.login(runtimeId, profileId, {
                wake: true
            })
            setSignIn({ operationId: op.id })
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
        }
    }

    const handleAdd = async (): Promise<void> => {
        setAdding(true)
        setError(null)
        try {
            const profile = await client.runtimeAuth.create(runtimeId, {
                authMethod: 'subscription'
            })
            await reloadAuth()
            await startProfileSignIn(profile.id)
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setAdding(false)
        }
    }

    const handleSignInDone = async (): Promise<void> => {
        const target = signIn
        setSignIn(null)
        if (target?.operationId) {
            reportOperation(
                await settleOperation(target.operationId),
                'web.runtimeAuth.signInFailed'
            )
            await reloadAuth()
            return
        }
        void probe(true)
    }

    const handleSignOut = async (
        profile: RuntimeAuthProfileView
    ): Promise<void> => {
        const name = profileDisplayName(profile)
        if (
            !(await confirm({
                title: t('web.runtimeAuth.signOutConfirmTitle', {
                    account: name
                }),
                description: t('web.runtimeAuth.signOutConfirmBody'),
                confirmLabel: t('web.runtimeAuth.signOut')
            }))
        )
            return
        setBusyProfile(profile.id)
        setError(null)
        try {
            const op = await client.runtimeAuth.logout(runtimeId, profile.id, {
                wake: true
            })
            reportOperation(
                operationSettled(op) ? op : await settleOperation(op.id),
                null
            )
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reloadAuth()
        }
    }

    const handleRemove = async (
        profile: RuntimeAuthProfileView
    ): Promise<void> => {
        const name = profileDisplayName(profile)
        if (
            !(await confirm({
                title: t('web.runtimeAuth.removeConfirmTitle', {
                    account: name
                }),
                description: t('web.runtimeAuth.removeConfirmBody'),
                confirmLabel: t('web.runtimeAuth.remove'),
                tone: 'danger'
            }))
        )
            return
        setBusyProfile(profile.id)
        setError(null)
        try {
            const op = await client.runtimeAuth.remove(runtimeId, profile.id, {
                wake: true
            })
            reportOperation(
                operationSettled(op) ? op : await settleOperation(op.id),
                null
            )
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reloadAuth()
        }
    }

    const handleSetDefault = async (
        profileId: string | null
    ): Promise<void> => {
        setBusyProfile(profileId ?? auth?.defaultProfileId ?? null)
        setError(null)
        try {
            await client.runtimeAuth.setDefault(runtimeId, { profileId })
        } catch (e) {
            setError(apiErrorMessage(e))
        } finally {
            setBusyProfile(null)
            await reloadAuth()
        }
    }

    const renderProfiles = (list: RuntimeAuthListView): ReactNode => {
        if (list.availability === 'host-unavailable')
            return <NoticeRow title={t('web.runtimeAuth.hostUnavailable')} />
        if (list.availability === 'daemon-upgrade-required')
            return (
                <NoticeRow
                    title={t('web.runtimeAuth.upgradeRequired')}
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
        // Offline and asleep are already explained by the host sign-in block
        // above; a second notice for the same host says nothing new.
        if (list.availability !== 'ok') return null
        return (
            <div className='settings-card'>
                <div className='settings-card-row'>
                    <div className='min-w-0'>
                        <div className='settings-card-label'>
                            {t('web.runtimeAuth.managedTitle')}
                        </div>
                        <div className='settings-card-copy'>
                            {t('web.runtimeAuth.addAccountHint')}
                        </div>
                    </div>
                    <div className='settings-card-side'>
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            disabled={adding || !list.capabilities.manage}
                            onClick={(): void => {
                                void handleAdd()
                            }}
                        >
                            {adding && <Spinner size={12} />}
                            {t('web.runtimeAuth.addAccount')}
                        </button>
                    </div>
                </div>
                {list.error && (
                    <div className='settings-card-row'>
                        <p className='text-caption text-error'>
                            {t('web.runtimeAuth.listFailed')} ({list.error})
                        </p>
                    </div>
                )}
                {list.profiles.length === 0 && (
                    <div className='settings-card-row'>
                        <p className='text-caption text-muted'>
                            {t('web.runtimeAuth.empty')}
                        </p>
                    </div>
                )}
                {list.profiles.map((profile) => (
                    <ProfileRow
                        key={profile.id}
                        profile={profile}
                        busy={busyProfile === profile.id}
                        onSignIn={(): void => {
                            void startProfileSignIn(profile.id)
                        }}
                        onSignOut={(): void => {
                            void handleSignOut(profile)
                        }}
                        onRemove={(): void => {
                            void handleRemove(profile)
                        }}
                        onSetDefault={(profileId): void => {
                            void handleSetDefault(profileId)
                        }}
                    />
                ))}
                {list.profiles.length > 0 && !list.capabilities.execute && (
                    <div className='settings-card-row'>
                        <p className='text-caption text-muted'>
                            {t('web.runtimeAuth.executeUnsupported')}{' '}
                            <Link
                                to={updatesPath('cli')}
                                className='text-link hover:text-fg font-medium'
                            >
                                {t('web.updates.reviewCta')}
                            </Link>
                        </p>
                    </div>
                )}
            </div>
        )
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
                                void refreshAll(true)
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
                    title={t(
                        'web.runtimeDetails.account.daemonUpgradeRequired'
                    )}
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
                            <Tag>{t('web.runtimeAuth.hostSignIn')}</Tag>
                            {plan && <Tag>{plan}</Tag>}
                            <StatusTag tone={tag.tone} label={tag.label} />
                        </div>
                    </div>
                    {view.usage?.windows.map((window) => (
                        <UsageWindowRow
                            key={`${window.key}:${window.scope ?? ''}`}
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
                {signInNeeded(view) && !signIn && (
                    <NoticeRow
                        title={t('web.chat.runtimeSignIn.title')}
                        detail={t('web.runtimeDetails.account.signInHint')}
                        action={
                            <button
                                type='button'
                                className='workbench-button-primary'
                                disabled={enablingTerminal}
                                onClick={(): void => {
                                    void handleHostSignIn()
                                }}
                            >
                                {enablingTerminal && <Spinner size={12} />}
                                {t('web.runtimeDetails.account.signIn')}
                            </button>
                        }
                    />
                )}
                {auth ? (
                    renderProfiles(auth)
                ) : authLoading ? (
                    <div className='settings-card' aria-busy='true'>
                        <GhostSettingsRows rows={1} action={false} />
                    </div>
                ) : authError ? (
                    <NoticeRow
                        tone='danger'
                        title={t('web.runtimeAuth.listFailed')}
                        detail={authError}
                    />
                ) : null}
                {signIn && (
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
                            operationId={signIn.operationId}
                            onDone={(): void => {
                                void handleSignInDone()
                            }}
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
                    disabled={loading || authLoading}
                    onClick={(): void => {
                        void refreshAll(true)
                    }}
                >
                    {loading || authLoading
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
