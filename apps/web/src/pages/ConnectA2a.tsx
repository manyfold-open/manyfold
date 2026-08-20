import type {
    A2aExposure,
    ConnectA2aSessionResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { Switch } from '@/components/ControlRow'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useI18n } from '@/lib/i18n'

const ConnectA2a: FC = (): ReactNode => {
    const location = useLocation()
    const [params] = useSearchParams()
    const next = `${location.pathname}${location.search}`

    return (
        <>
            <SignedOut>
                <Navigate
                    to={`/login?redirect_url=${encodeURIComponent(next)}`}
                    replace
                />
            </SignedOut>
            <SignedIn>
                <ConnectA2aContent
                    requestId={params.get('request') ?? ''}
                    userCode={params.get('code') ?? ''}
                />
            </SignedIn>
        </>
    )
}

type Phase =
    | { state: 'idle' }
    | { state: 'approving' }
    | { state: 'done'; agentCount: number }
    | { state: 'denied' }

const isExposed = (agent: SdkAgent): boolean =>
    Boolean(
        (agent.extras as { a2aExposure?: A2aExposure } | null)?.a2aExposure
            ?.enabled
    )

const ConnectA2aContent: FC<{
    requestId: string
    userCode: string
}> = ({ requestId, userCode }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { user: currentUser } = useCurrentUser()
    const [session, setSession] = useState<ConnectA2aSessionResponse | null>(
        null
    )
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [phase, setPhase] = useState<Phase>({ state: 'idle' })
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [enableExposure, setEnableExposure] = useState(false)

    useEffect(() => {
        if (!requestId || !userCode) return
        let cancelled = false
        void Promise.all([
            client.connectA2a.getSession(requestId, userCode),
            client.agents.list()
        ])
            .then(([s, agentList]) => {
                if (cancelled) return
                setSession(s)
                setAgents(agentList)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setLoadError((err as Error).message)
            })
        return () => {
            cancelled = true
        }
    }, [client, requestId, userCode])

    const unexposedSelected = useMemo(
        () =>
            (agents ?? []).filter(
                (agent) => selected.has(agent.id) && !isExposed(agent)
            ),
        [agents, selected]
    )

    const toggle = (agent: SdkAgent, checked: boolean): void => {
        setSelected((prev) => {
            const ns = new Set(prev)
            if (checked) ns.add(agent.id)
            else ns.delete(agent.id)
            return ns
        })
        if (checked && !isExposed(agent)) setEnableExposure(true)
    }

    const doApprove = async (): Promise<void> => {
        if (!requestId || !session) return
        if (selected.size === 0) {
            setError(t('web.connectA2a.selectAgent'))
            return
        }
        if (unexposedSelected.length > 0 && !enableExposure) {
            setError(t('web.connectA2a.exposureRequired'))
            return
        }
        setPhase({ state: 'approving' })
        setError(null)
        try {
            const result = await client.connectA2a.approve({
                requestId,
                userCode,
                agentIds: [...selected],
                enableExposure
            })
            setPhase({ state: 'done', agentCount: result.agentCount })
        } catch (err) {
            setError(apiErrorDetailMessage(err))
            setPhase({ state: 'idle' })
        }
    }

    const doDeny = async (): Promise<void> => {
        if (!requestId) return
        setError(null)
        try {
            await client.connectA2a.deny({ requestId, userCode })
            setPhase({ state: 'denied' })
        } catch (err) {
            setError(apiErrorDetailMessage(err))
        }
    }

    if (!requestId || !userCode) {
        return (
            <Shell title={t('web.connectA2a.title')}>
                <div className='workbench-alert-error'>
                    {t('web.connectA2a.missingRequest')}
                </div>
            </Shell>
        )
    }

    if (loadError) {
        return (
            <Shell title={t('web.connectA2a.title')}>
                <div className='workbench-alert-error'>{loadError}</div>
            </Shell>
        )
    }

    if (!session || agents === null) {
        return (
            <Shell title={t('web.connectA2a.title')}>
                <p className='text-muted text-ui'>
                    {t('web.connectA2a.loading')}
                </p>
            </Shell>
        )
    }

    if (phase.state === 'done') {
        return (
            <Shell
                title={t('web.connectA2a.doneTitle', {
                    count: phase.agentCount
                })}
            >
                <div className='workbench-note'>
                    {t('web.connectA2a.doneHint', {
                        clientName: session.clientName
                    })}
                </div>
            </Shell>
        )
    }

    if (phase.state === 'denied') {
        return (
            <Shell title={t('web.connectA2a.deniedTitle')}>
                <div className='workbench-note'>
                    {t('web.connectA2a.deniedHint')}
                </div>
            </Shell>
        )
    }

    if (session.status === 'expired') {
        return (
            <Shell title={t('web.connectA2a.title')}>
                <div className='workbench-note'>
                    {t('web.connectA2a.expired')}
                </div>
            </Shell>
        )
    }

    if (session.status !== 'pending') {
        return (
            <Shell title={t('web.connectA2a.title')}>
                <div className='workbench-note'>
                    {t('web.connectA2a.alreadyDone')}
                </div>
            </Shell>
        )
    }

    const busy = phase.state === 'approving'

    return (
        <Shell
            title={t('web.connectA2a.title')}
            subtitle={t('web.connectA2a.subtitle')}
        >
            <div>
                <p className='workbench-group-label'>
                    {t('web.connectA2a.requesterLabel')}
                </p>
                <p className='text-fg text-ui mt-1 font-medium'>
                    {session.clientName}
                </p>
                {session.clientUrl && (
                    <p className='text-subtle text-caption mt-0.5 break-all'>
                        {session.clientUrl}
                    </p>
                )}
                <p className='workbench-hint'>
                    {t('web.connectA2a.unverifiedNote')}
                </p>
            </div>

            <div>
                <p className='text-fg text-ui font-medium'>
                    {t('web.connectA2a.codeCheckHint')}
                </p>
                <div className='bg-surface-subtle border-divider mt-2 rounded-md border px-4 py-3 text-center font-mono text-xl font-medium'>
                    {userCode}
                </div>
            </div>

            <div className='workbench-note'>
                <p>{t('web.connectA2a.consequence')}</p>
                <p className='mt-2'>{t('web.connectA2a.safety')}</p>
            </div>

            <div>
                <p className='workbench-field-label'>
                    {t('web.connectA2a.agentsLabel')}
                </p>
                {agents.length === 0 ? (
                    <p className='text-muted text-ui'>
                        {t('web.connectA2a.noAgents')}
                    </p>
                ) : (
                    <ul className='max-h-72 space-y-2 overflow-y-auto'>
                        {agents.map((agent) => {
                            const checked = selected.has(agent.id)
                            const exposed = isExposed(agent)
                            return (
                                <li
                                    key={agent.id}
                                    className='border-divider bg-surface rounded-md border px-3.5 py-3'
                                >
                                    <label className='flex cursor-pointer items-center gap-3'>
                                        <input
                                            type='checkbox'
                                            className='border-divider text-fg focus-visible:ring-focus h-4 w-4 rounded'
                                            checked={checked}
                                            disabled={busy}
                                            onChange={(e) =>
                                                toggle(agent, e.target.checked)
                                            }
                                        />
                                        <span className='text-ui text-fg min-w-0 flex-1 truncate'>
                                            {agent.name}
                                        </span>
                                        <code className='text-caption text-subtle shrink-0 font-mono'>
                                            {agent.framework}
                                        </code>
                                        <span className='flex shrink-0 items-center gap-1.5'>
                                            <span
                                                className={`h-2.5 w-2.5 shrink-0 rounded-full ${exposed ? 'bg-success' : 'bg-idle'}`}
                                            />
                                            <span className='text-caption text-subtle'>
                                                {exposed
                                                    ? t(
                                                          'web.connectA2a.exposedBadge'
                                                      )
                                                    : t(
                                                          'web.connectA2a.notExposedBadge'
                                                      )}
                                            </span>
                                        </span>
                                    </label>
                                </li>
                            )
                        })}
                    </ul>
                )}
                <p className='workbench-hint'>
                    {t('web.connectA2a.agentsHint')}
                </p>
            </div>

            <div className='border-divider bg-surface flex items-center gap-3 rounded-md border px-3.5 py-3'>
                <Switch
                    checked={enableExposure}
                    disabled={busy}
                    onChange={() => setEnableExposure((prev) => !prev)}
                    ariaLabel={t('web.connectA2a.enableExposureLabel')}
                />
                <div className='min-w-0'>
                    <p className='text-ui text-fg font-medium'>
                        {t('web.connectA2a.enableExposureLabel')}
                    </p>
                    {unexposedSelected.length > 0 && (
                        <p className='text-caption text-workflow-ship mt-0.5'>
                            {t('web.connectA2a.enableExposureHint')}
                        </p>
                    )}
                </div>
            </div>

            {currentUser?.email && (
                <p className='text-subtle text-caption'>
                    {t('web.connectA2a.signedInAs')}{' '}
                    <span className='text-fg'>{currentUser.email}</span>
                </p>
            )}

            {error && <div className='workbench-alert-error'>{error}</div>}

            <div className='flex flex-wrap gap-2'>
                <button
                    type='button'
                    className='workbench-button-primary'
                    disabled={busy || selected.size === 0}
                    onClick={() => void doApprove()}
                >
                    {busy
                        ? t('web.connectA2a.approving')
                        : t('web.connectA2a.approve')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    disabled={busy}
                    onClick={() => void doDeny()}
                >
                    {t('web.connectA2a.deny')}
                </button>
            </div>
        </Shell>
    )
}

const Shell: FC<{
    title: string
    subtitle?: string
    children: ReactNode
}> = ({ title, subtitle, children }): ReactNode => (
    <div className='text-fg bg-main flex min-h-screen items-center justify-center px-5 py-10'>
        <main className='workbench-panel w-full max-w-[34rem] px-6 py-6'>
            <div className='space-y-5'>
                <div>
                    <h1 className='text-h2'>{title}</h1>
                    {subtitle && (
                        <p className='text-muted text-ui mt-1'>{subtitle}</p>
                    )}
                </div>
                {children}
            </div>
        </main>
    </div>
)

export default ConnectA2a
