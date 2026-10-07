import type {
    A2aExposure,
    ConnectA2aSessionResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { Switch } from '@/components/ControlRow'
import DialogPage, { VerificationCode } from '@/components/DialogPage'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useI18n } from '@/lib/i18n'

const ConnectA2a: FC = (): ReactNode => {
    const location = useLocation()
    const [params] = useSearchParams()

    return (
        <>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
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

    const title = t('web.connectA2a.title')

    if (!requestId || !userCode) {
        return (
            <DialogPage title={title}>
                <div className='workbench-alert-error' role='alert'>
                    {t('web.connectA2a.missingRequest')}
                </div>
            </DialogPage>
        )
    }

    if (loadError) {
        return (
            <DialogPage title={title}>
                <div className='workbench-alert-error' role='alert'>
                    {loadError}
                </div>
            </DialogPage>
        )
    }

    if (!session || agents === null) {
        return (
            <DialogPage
                title={title}
                description={t('web.connectA2a.loading')}
            />
        )
    }

    if (phase.state === 'done') {
        return (
            <DialogPage
                title={t('web.connectA2a.doneTitle', {
                    count: phase.agentCount
                })}
                description={t('web.connectA2a.doneHint', {
                    clientName: session.clientName
                })}
            />
        )
    }

    if (phase.state === 'denied') {
        return (
            <DialogPage
                title={t('web.connectA2a.deniedTitle')}
                description={t('web.connectA2a.deniedHint')}
            />
        )
    }

    if (session.status === 'expired') {
        return (
            <DialogPage
                title={title}
                description={t('web.connectA2a.expired')}
            />
        )
    }

    if (session.status !== 'pending') {
        return (
            <DialogPage
                title={title}
                description={t('web.connectA2a.alreadyDone')}
            />
        )
    }

    const busy = phase.state === 'approving'

    return (
        <DialogPage
            title={title}
            description={t('web.connectA2a.consequence')}
            meta={
                currentUser?.email && (
                    <>
                        {t('web.connectA2a.signedInAs')}{' '}
                        <span className='text-fg'>{currentUser.email}</span>
                    </>
                )
            }
            actions={
                <>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        disabled={busy}
                        onClick={() => void doDeny()}
                    >
                        {t('web.connectA2a.deny')}
                    </button>
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
                </>
            }
        >
            <div>
                <p className='workbench-field-label'>
                    {t('web.connectA2a.requesterLabel')}
                </p>
                <p className='text-fg text-ui font-medium'>
                    {session.clientName}
                </p>
                {session.clientUrl && (
                    <p className='text-subtle text-caption mt-0.5 break-all'>
                        {session.clientUrl}
                    </p>
                )}
                <p className='text-subtle text-caption mt-0.5'>
                    {t('web.connectA2a.unverifiedNote')}
                </p>
            </div>

            <VerificationCode
                label={t('web.connectA2a.codeCheckHint')}
                code={userCode}
            />

            <div>
                <p className='workbench-field-label'>
                    {t('web.connectA2a.agentsLabel')}
                </p>
                {agents.length === 0 ? (
                    <p className='text-muted text-ui'>
                        {t('web.connectA2a.noAgents')}
                    </p>
                ) : (
                    <ul className='border-divider divide-divider max-h-72 divide-y overflow-y-auto rounded-sm border'>
                        {agents.map((agent) => {
                            const checked = selected.has(agent.id)
                            const exposed = isExposed(agent)
                            return (
                                <li key={agent.id}>
                                    <label className='flex cursor-pointer items-center gap-3 px-3.5 py-2.5'>
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
                {unexposedSelected.length > 0 && (
                    <div className='mt-3 flex items-start gap-3'>
                        <Switch
                            checked={enableExposure}
                            disabled={busy}
                            onChange={() => setEnableExposure((prev) => !prev)}
                            ariaLabel={t('web.connectA2a.enableExposureLabel')}
                        />
                        <div className='min-w-0'>
                            <p className='text-ui text-fg'>
                                {t('web.connectA2a.enableExposureLabel')}
                            </p>
                            <p className='text-caption text-workflow-ship mt-0.5'>
                                {t('web.connectA2a.enableExposureHint')}
                            </p>
                        </div>
                    </div>
                )}
            </div>

            {error && (
                <div className='workbench-alert-error' role='alert'>
                    {error}
                </div>
            )}
        </DialogPage>
    )
}

export default ConnectA2a
