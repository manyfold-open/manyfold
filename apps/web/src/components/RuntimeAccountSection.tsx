import { useCallback } from 'react'
import type { FC, ReactNode } from 'react'
import type { AgentRuntimeSummary } from '@manyfold/shared'
import { GhostSettingsRows } from '@/components/Loading'
import { RuntimeAccountList } from '@/components/RuntimeAccountList'
import { NoticeRow, relative, Section } from '@/components/RuntimeDetailPanel'
import { useI18n } from '@/lib/i18n'
import { useRuntimeAccount } from '@/lib/useRuntimeAccount'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'

// The runtime page's Account section: the host probe (who the machine is
// signed in as, and its usage) framing the shared account list. Opening the
// page reads a host that is awake and otherwise falls back to the cached
// last-good probe, so the account stays named while the sandbox sleeps; the
// list's own notices carry the wake affordances, and Refresh (or a sign-in)
// is the user's explicit consent to wake.
const RuntimeAccountSection: FC<{ runtime: AgentRuntimeSummary }> = ({
    runtime
}): ReactNode => {
    const { t } = useI18n()
    const runtimeId = runtime.id
    const { view, lastOk, loading, error, probe } =
        useRuntimeAccount(runtimeId)
    const {
        list: auth,
        loading: authLoading,
        error: authError,
        reload: reloadAuth
    } = useRuntimeAuthList(runtimeId)

    const refreshAll = useCallback(
        async (wake: boolean): Promise<void> => {
            await probe(wake)
            await reloadAuth({ wake })
        },
        [probe, reloadAuth]
    )

    // The list's own wake buttons (start runner, check again) reload only the
    // list; wrap its reload so a wake refreshes the host probe too, or the
    // host card would keep the cached identity after the sandbox came up.
    const reloadAll = useCallback(
        async (opts?: { wake?: boolean }) => {
            if (opts?.wake) void probe(true)
            return reloadAuth(opts)
        },
        [probe, reloadAuth]
    )

    const checkedAt = view?.checkedAt ?? lastOk?.checkedAt ?? null

    const renderBody = (): ReactNode => {
        if (view?.status === 'unsupported') return null
        // The list's ambient row is fresher than our cache whenever the host
        // answered the list call; the cache only stands in when neither the
        // live probe nor the ambient row has an account to show.
        const ambient =
            auth?.availability === 'ok' && auth.ambient?.status === 'ok'
                ? auth.ambient
                : null
        const hostView = view?.status === 'ok' ? view : ambient ? null : lastOk
        if (!auth || (!view && !hostView)) {
            if (loading || authLoading)
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
            <>
                {view?.status === 'probe-failed' && (
                    <NoticeRow
                        tone='danger'
                        title={t('web.runtimeDetails.account.probeFailed')}
                        detail={view.error}
                    />
                )}
                <RuntimeAccountList
                    runtime={runtime}
                    list={auth}
                    loading={authLoading}
                    reload={reloadAll}
                    host={hostView}
                    usage={
                        view?.status === 'ok'
                            ? view.usage
                            : (ambient?.usage ?? lastOk?.usage ?? null)
                    }
                    onHostSignedIn={(): void => {
                        void probe(true)
                    }}
                    onRefreshUsage={(): void => {
                        void probe(true, true)
                    }}
                />
            </>
        )
    }

    return (
        <Section
            title={t('web.runtimeDetails.account.title')}
            action={
                <div className='text-caption flex items-center gap-3'>
                    {checkedAt && (
                        <span className='text-subtle'>
                            {t('web.runtimeDetails.checked', {
                                time: relative(checkedAt)
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
