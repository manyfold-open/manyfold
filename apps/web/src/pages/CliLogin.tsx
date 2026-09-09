import {
    CliLoginSessionResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
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
    const { user: currentUser } = useCurrentUser()
    const [session, setSession] = useState<CliLoginSessionResponse | null>(
        null
    )
    const [loadError, setLoadError] = useState<string | null>(null)
    const [authCode, setAuthCode] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [approve, setApprove] = useState<ApproveState>({ state: 'idle' })

    useEffect(() => {
        if (!requestId || !userCode) return
        let cancelled = false
        void client.auth
            .getCliLoginSession(requestId, userCode)
            .then((s) => {
                if (cancelled) return
                setSession(s)
            })
            .catch((err: unknown) => {
                if (cancelled) return
                setLoadError((err as Error).message)
            })
        return () => {
            cancelled = true
        }
    }, [client, requestId, userCode])

    const doApprove = async (): Promise<void> => {
        if (!requestId) return
        setApprove({ state: 'authorizing' })
        setError(null)
        try {
            const result = await client.auth.approveCliLogin({
                requestId,
                userCode,
            })
            if (result.redirectUrl) {
                setApprove({ state: 'redirecting' })
                window.location.assign(result.redirectUrl)
                return
            }
            if (result.authCode) {
                setAuthCode(result.authCode)
                setApprove({ state: 'done' })
            }
        } catch (err) {
            setError(apiErrorDetailMessage(err))
            setApprove({ state: 'idle' })
        }
    }

    const title = t('web.cliLogin.titleLogin')
    const subtitle = t('web.cliLogin.subtitleLogin')

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

            <BrowserBody
                onApprove={() => void doApprove()}
                approve={approve}
            />

            {error && <div className='workbench-alert-error'>{error}</div>}

            <p className='text-subtle text-caption border-t pt-4'>
                {t('web.cliLogin.safety')}
            </p>
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
                    <h1 className='text-h1 text-fg'>{title}</h1>
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

export default CliLogin
