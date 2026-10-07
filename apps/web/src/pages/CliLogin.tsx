import {
    CliLoginSessionResponse
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import DialogPage, { VerificationCode } from '@/components/DialogPage'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage } from '@/lib/errorMessage'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { isMobileDevice } from '@/lib/mobileDevice'
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
    const [authCodeCopied, setAuthCodeCopied] = useState(false)
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

    const doApprove = async (showCode: boolean): Promise<void> => {
        if (!requestId) return
        setApprove({ state: 'authorizing' })
        setError(null)
        try {
            const result = await client.auth.approveCliLogin({
                requestId,
                userCode,
            })
            // The approval returns the auth code even when mf waits on a
            // 127.0.0.1 redirect, and exchange accepts it either way. A
            // browser on another device (a phone steering an agent) shows it
            // to paste: the redirect would reach that device's own 127.0.0.1,
            // and mf would wait out the whole session.
            if (result.redirectUrl && !showCode) {
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

    if (!requestId || !userCode) {
        return (
            <DialogPage title={title}>
                <div className='workbench-alert-error' role='alert'>
                    {t('web.cliLogin.missingRequest')}
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

    if (!session) {
        return (
            <DialogPage title={title} description={t('web.cliLogin.loading')} />
        )
    }

    if (session.status === 'expired') {
        return (
            <DialogPage title={title} description={t('web.cliLogin.expired')} />
        )
    }

    if (session.status !== 'pending' && approve.state !== 'done') {
        return (
            <DialogPage
                title={title}
                description={t('web.cliLogin.alreadyDone')}
            />
        )
    }

    if (authCode) {
        return (
            <DialogPage
                title={t('web.cliLogin.authCodeTitle')}
                description={t(
                    session.hasRedirect
                        ? 'web.cliLogin.authCodeHintRedirect'
                        : 'web.cliLogin.authCodeHint'
                )}
            >
                <div className='flex items-start gap-2'>
                    <div className='bg-surface-subtle border-divider min-w-0 flex-1 rounded-sm border px-4 py-3 font-mono text-sm break-all'>
                        {authCode}
                    </div>
                    <button
                        type='button'
                        onClick={() => {
                            void navigator.clipboard
                                ?.writeText(authCode)
                                .then(() => setAuthCodeCopied(true))
                        }}
                        className='workbench-button-secondary text-ui h-9 shrink-0 px-3'
                    >
                        {authCodeCopied ? t('common.copied') : t('common.copy')}
                    </button>
                </div>
            </DialogPage>
        )
    }

    const mobile = isMobileDevice(navigator)
    const busy = approve.state !== 'idle'

    return (
        <DialogPage
            title={title}
            description={t('web.cliLogin.consequence')}
            meta={
                currentUser?.email && (
                    <>
                        {t('web.cliLogin.signedInAs')}{' '}
                        <span className='text-fg'>{currentUser.email}</span>
                    </>
                )
            }
            actions={
                <button
                    type='button'
                    className='workbench-button-primary'
                    disabled={busy}
                    onClick={() => void doApprove(mobile)}
                >
                    {approve.state === 'redirecting'
                        ? t('web.cliLogin.redirecting')
                        : approve.state === 'authorizing'
                          ? t('web.cliLogin.authorizing')
                          : t('web.cliLogin.authorize')}
                </button>
            }
        >
            <div>
                <VerificationCode
                    label={t('web.cliLogin.codeCheckHint')}
                    code={userCode}
                />
                {session.hasRedirect && !mobile && (
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => void doApprove(true)}
                        className='text-caption text-link hover:text-link-hover mt-2 block font-medium disabled:opacity-50'
                    >
                        {t('web.cliLogin.useCodeInstead')}
                    </button>
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

export default CliLogin
