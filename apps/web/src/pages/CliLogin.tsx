import {
    CliLoginSessionResponse,
    GrantableScope,
    ScopeMetadata,
    isGrantableScope,
    scopeMetadata
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ScopeChecklist } from '@/components/auth/ScopeChecklist'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { useI18n } from '@/lib/i18n'

const CliLogin: FC = (): ReactNode => {
    const location = useLocation()
    const [params] = useSearchParams()

    return (
        <>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
            </SignedOut>
            <SignedIn>
                <CliLoginContent
                    requestId={params.get('request') ?? ''}
                    userCode={params.get('code') ?? ''}
                />
            </SignedIn>
        </>
    )
}

interface ApproveState {
    state: 'idle' | 'authorizing' | 'redirecting' | 'done'
}

const CliLoginContent: FC<{
    requestId: string
    userCode: string
}> = ({ requestId, userCode }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const { user: currentUser } = useCurrentUser()
    const [session, setSession] = useState<CliLoginSessionResponse | null>(
        null
    )
    const [loadError, setLoadError] = useState<string | null>(null)
    const [authCode, setAuthCode] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [approve, setApprove] = useState<ApproveState>({ state: 'idle' })
    const [selected, setSelected] = useState<Set<GrantableScope>>(new Set())

    useEffect(() => {
        if (!requestId || !userCode) return
        let cancelled = false
        void client.auth
            .getCliLoginSession(requestId, userCode)
            .then((s) => {
                if (cancelled) return
                setSession(s)
                if (s.isGrantMode) {
                    const valid =
                        s.requestedScopes?.filter(isGrantableScope) ?? []
                    // Don't pre-check high-danger scopes even if the agent
                    // requested them. The user must explicitly opt in.
                    const dangerByScope = new Map<GrantableScope, ScopeMetadata['danger']>(
                        scopeMetadata.map((m) => [m.scope, m.danger])
                    )
                    const initiallyChecked = valid.filter(
                        (s) => dangerByScope.get(s) !== 'high'
                    )
                    setSelected(new Set<GrantableScope>(initiallyChecked))
                }
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setLoadError((err as Error).message)
            })
        return () => {
            cancelled = true
        }
    }, [client, requestId, userCode])

    const requestedScopes = useMemo<GrantableScope[]>(
        () => session?.requestedScopes?.filter(isGrantableScope) ?? [],
        [session]
    )

    const dangerHighSelected = useMemo(
        () =>
            scopeMetadata.filter(
                (m: ScopeMetadata) =>
                    m.danger === 'high' && selected.has(m.scope)
            ),
        [selected]
    )

    const toggleScope = (scope: GrantableScope, next: boolean): void => {
        setSelected((prev) => {
            const ns = new Set(prev)
            if (next) ns.add(scope)
            else ns.delete(scope)
            return ns
        })
    }

    const doApprove = async (): Promise<void> => {
        if (!requestId) return
        if (session?.isGrantMode && selected.size === 0) {
            setError(t('web.cliLogin.selectScope'))
            return
        }
        if (session?.isGrantMode && dangerHighSelected.length > 0) {
            const scopeList = dangerHighSelected
                .map((m) => m.scope)
                .join(', ')
            const ok = await confirm({
                title: t('web.cliLogin.highRiskTitle'),
                description: (
                    <>
                        <p>{t('web.cliLogin.highRiskBody1')}</p>
                        <p className='text-fg mt-2 font-mono'>{scopeList}</p>
                        <p className='mt-2'>
                            {t('web.cliLogin.highRiskBody2')}
                        </p>
                    </>
                ),
                confirmLabel: t('web.cliLogin.highRiskConfirm'),
                tone: 'danger'
            })
            if (!ok) return
        }
        setApprove({ state: 'authorizing' })
        setError(null)
        try {
            const approvedScopes =
                session?.isGrantMode && selected.size > 0
                    ? [...selected]
                    : undefined
            const result = await client.auth.approveCliLogin({
                requestId,
                userCode,
                approvedScopes
            })
            if (result.redirectUrl) {
                setApprove({ state: 'redirecting' })
                window.location.assign(result.redirectUrl)
                return
            }
            if (result.mode === 'grant') {
                setApprove({ state: 'done' })
            } else if (result.authCode) {
                setAuthCode(result.authCode)
                setApprove({ state: 'done' })
            }
        } catch (err) {
            setError(apiErrorDetailMessage(err))
            setApprove({ state: 'idle' })
        }
    }

    const isGrant = session?.isGrantMode ?? false
    const title = isGrant
        ? t('web.cliLogin.titleGrant')
        : t('web.cliLogin.titleLogin')
    const subtitle = isGrant
        ? t('web.cliLogin.subtitleGrant')
        : t('web.cliLogin.subtitleLogin')

    if (!requestId || !userCode) {
        return (
            <Shell title={t('web.cliLogin.titleLogin')}>
                <div className='workbench-alert-error'>
                    {t('web.cliLogin.missingRequest')}
                </div>
            </Shell>
        )
    }

    if (loadError) {
        return (
            <Shell title={t('web.cliLogin.titleLogin')}>
                <div className='workbench-alert-error'>{loadError}</div>
            </Shell>
        )
    }

    if (!session) {
        return (
            <Shell title={t('web.cliLogin.titleLogin')}>
                <p className='text-muted text-ui'>
                    {t('web.cliLogin.loading')}
                </p>
            </Shell>
        )
    }

    if (session.status === 'expired') {
        return (
            <Shell title={title}>
                <div className='workbench-alert-error'>
                    {t('web.cliLogin.expired')}
                </div>
            </Shell>
        )
    }

    if (session.status !== 'pending' && approve.state !== 'done') {
        return (
            <Shell title={title}>
                <div className='workbench-note'>
                    {t('web.cliLogin.alreadyDone')}
                </div>
            </Shell>
        )
    }

    if (approve.state === 'done' && session.isGrantMode) {
        return (
            <Shell title={title}>
                <div className='workbench-note'>
                    <p className='text-fg font-medium'>
                        {t('web.cliLogin.grantDoneTitle')}
                    </p>
                    <p className='text-muted text-ui mt-1'>
                        {t('web.cliLogin.grantDoneHint')}
                    </p>
                </div>
            </Shell>
        )
    }

    if (authCode) {
        return (
            <Shell title={t('web.cliLogin.authCodeTitle')}>
                <div className='space-y-2'>
                    <p className='text-fg text-ui'>
                        {t('web.cliLogin.authCodeHint')}
                    </p>
                    <div className='bg-surface-subtle border-divider rounded-md border px-4 py-3 font-mono text-sm break-all'>
                        {authCode}
                    </div>
                </div>
            </Shell>
        )
    }

    return (
        <Shell title={title} subtitle={subtitle}>
            <div>
                <p className='text-fg text-ui font-medium'>
                    {t('web.cliLogin.codeCheckHint')}
                </p>
                <div className='bg-surface-subtle border-divider mt-2 rounded-md border px-4 py-3 text-center font-mono text-xl font-medium'>
                    {userCode}
                </div>
            </div>

            {currentUser?.email && (
                <p className='text-subtle text-caption'>
                    {t('web.cliLogin.signedInAs')}{' '}
                    <span className='text-fg'>{currentUser.email}</span>
                </p>
            )}

            {session.isGrantMode ? (
                <GrantBody
                    session={session}
                    requestedScopes={requestedScopes}
                    selected={selected}
                    onToggle={toggleScope}
                    busy={approve.state !== 'idle'}
                    onApprove={() => void doApprove()}
                />
            ) : (
                <BrowserBody
                    onApprove={() => void doApprove()}
                    approve={approve}
                />
            )}

            {error && <div className='workbench-alert-error'>{error}</div>}

            <p className='text-subtle text-caption border-t pt-4'>
                {t('web.cliLogin.safety')}
            </p>
            {confirmDialog}
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

const BrowserBody: FC<{
    onApprove: () => void
    approve: ApproveState
}> = ({ onApprove, approve }): ReactNode => {
    const { t } = useI18n()
    return (
        <div>
            <button
                type='button'
                className='workbench-button-primary'
                disabled={approve.state !== 'idle'}
                onClick={onApprove}
            >
                {approve.state === 'redirecting'
                    ? t('web.cliLogin.redirecting')
                    : approve.state === 'authorizing'
                      ? t('web.cliLogin.authorizing')
                      : t('web.cliLogin.authorize')}
            </button>
            <p className='text-subtle text-caption mt-2'>
                {t('web.cliLogin.consequence')}
            </p>
        </div>
    )
}

const GrantBody: FC<{
    session: CliLoginSessionResponse
    requestedScopes: GrantableScope[]
    selected: Set<GrantableScope>
    onToggle: (scope: GrantableScope, next: boolean) => void
    busy: boolean
    onApprove: () => void
}> = ({
    session,
    requestedScopes,
    selected,
    onToggle,
    busy,
    onApprove
}): ReactNode => {
    const { t } = useI18n()
    const agentLabel = session.requestedAgent
        ? `${session.requestedAgent.name} (${session.requestedAgent.id})`
        : t('web.cliLogin.unknownAgent')
    return (
        <div className='space-y-4'>
            <div>
                <div className='workbench-field-label'>
                    {t('web.cliLogin.requestingAgent')}
                </div>
                <div className='text-fg text-ui'>{agentLabel}</div>
            </div>

            <div className='workbench-note'>{t('web.cliLogin.grantNote')}</div>

            <div>
                <div className='workbench-field-label mb-2'>
                    {t('web.cliLogin.permissionsLabel')}
                </div>
                <p className='text-caption text-subtle mb-3'>
                    {t('web.cliLogin.permissionsHint')}
                </p>
                <ScopeChecklist
                    requestedScopes={requestedScopes}
                    selectedScopes={[...selected]}
                    onToggle={onToggle}
                    disabled={busy}
                />
            </div>

            <div className='flex flex-wrap gap-2'>
                <button
                    type='button'
                    className='workbench-button-primary'
                    disabled={busy || selected.size === 0}
                    onClick={onApprove}
                >
                    {busy
                        ? t('web.cliLogin.authorizing')
                        : t('web.cliLogin.approve')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    disabled={busy}
                    onClick={() => window.close()}
                >
                    {t('web.cliLogin.cancel')}
                </button>
            </div>
        </div>
    )
}

export default CliLogin
