import { useCallback, useEffect, useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type { AgentRuntimeSummary, RuntimeAccountView } from '@manyfold/shared'
import { Link } from 'react-router-dom'
import { GhostSettingsRows, Spinner } from '@/components/Loading'
import { RuntimeAccountList } from '@/components/RuntimeAccountList'
import { NoticeRow, relative, Section } from '@/components/RuntimeDetailPanel'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { updatesPath } from '@/lib/updateCenter'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'

// The runtime page's Account section: the host probe (who the machine is
// signed in as, and its usage) framing the shared account list. Opening the
// page reads a host that is awake; Refresh (and any sign-in) is the user's
// explicit consent to wake a sleeping sandbox.
const RuntimeAccountSection: FC<{ runtime: AgentRuntimeSummary }> = ({
    runtime
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [view, setView] = useState<RuntimeAccountView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const runtimeId = runtime.id
    const {
        list: auth,
        loading: authLoading,
        error: authError,
        reload: reloadAuth
    } = useRuntimeAuthList(runtimeId)

    const probe = useCallback(
        async (wake: boolean, refreshUsage = false): Promise<void> => {
            setLoading(true)
            setError(null)
            try {
                setView(
                    await client.agentRuntimes.getAccount(runtimeId, {
                        wake,
                        refreshUsage
                    })
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

    // A wake from this page holds the sandbox awake for a few minutes so the
    // sign-in it was for does not pay a second wake; leaving the page lets
    // it go, so the sandbox suspends on its own and gives the plan's active
    // slot back.
    const wokeRef = useRef(false)
    const refreshAll = useCallback(
        async (wake: boolean): Promise<void> => {
            if (wake) wokeRef.current = true
            await probe(wake)
            await reloadAuth({ wake })
        },
        [probe, reloadAuth]
    )
    useEffect(
        () => (): void => {
            if (wokeRef.current)
                void client.runtimeAuth.release(runtimeId).catch(() => null)
        },
        [client, runtimeId]
    )

    const wakeAction = (label: string): ReactNode => (
        <button
            type='button'
            className='workbench-button-secondary'
            disabled={loading}
            onClick={(): void => {
                void refreshAll(true)
            }}
        >
            {loading && <Spinner size={12} />}
            {label}
        </button>
    )

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
                    action={wakeAction(
                        t('web.runtimeDetails.account.checkNow')
                    )}
                />
            )
        if (view.status === 'sandbox-limit')
            return (
                <NoticeRow
                    title={t('web.runtimeDetails.account.sandboxLimit')}
                    detail={view.error}
                    action={wakeAction(
                        t('web.runtimeDetails.account.checkNow')
                    )}
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
        if (auth)
            return (
                <RuntimeAccountList
                    runtime={runtime}
                    list={auth}
                    loading={authLoading}
                    reload={reloadAuth}
                    host={view}
                    usage={view.usage}
                    onHostSignedIn={(): void => {
                        void probe(true)
                    }}
                    onRefreshUsage={(): void => {
                        void probe(true, true)
                    }}
                />
            )
        if (authLoading)
            return (
                <div className='settings-card' aria-busy='true'>
                    <GhostSettingsRows rows={2} action={false} />
                </div>
            )
        if (authError)
            return (
                <NoticeRow
                    tone='danger'
                    title={t('web.runtimeAuth.listFailed')}
                    detail={authError}
                />
            )
        return null
    }

    return (
        <Section
            title={t('web.runtimeDetails.account.title')}
            action={
                <div className='text-caption flex items-center gap-3'>
                    {view?.checkedAt && (
                        <span className='text-subtle'>
                            {t('web.runtimeDetails.checked', {
                                time: relative(view.checkedAt)
                            })}
                        </span>
                    )}
                    <button
                        type='button'
                        className='text-link hover:text-fg disabled:text-muted font-medium disabled:cursor-not-allowed'
                        disabled={loading || authLoading}
                        onClick={(): void => {
                            void refreshAll(true)
                        }}
                    >
                        {loading || authLoading
                            ? t('web.chat.runtimeSignIn.checking')
                            : t('web.runtimeDetails.refresh')}
                    </button>
                </div>
            }
        >
            {error && <div className='workbench-alert-error mb-3'>{error}</div>}
            {renderBody()}
        </Section>
    )
}

export default RuntimeAccountSection
