import { type FC, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { SquareTerminal } from 'lucide-react'
import { BrandMark } from '@/components/Brand'
import { PreferenceControls } from '@/components/PreferenceControls'
import { AuthSignIn, SignedIn } from '@/lib/auth'
import { safeRedirectPath } from '@/lib/loginRedirect'
import { useI18n } from '@/lib/i18n'

const Login: FC = (): ReactNode => {
    const { t } = useI18n()
    const [params] = useSearchParams()
    const redirectUrl =
        safeRedirectPath(params.get('redirect_url')) ?? '/workspace'
    // Invite-redemption links land here pre-marked for sign-up with the
    // invited email locked in; everyone else gets the plain sign-in form.
    const isInvite = params.get('invite') === 'true'
    const inviteEmail = params.get('email')?.trim() || undefined
    // An agent running mf login opened this tab, often for someone who has
    // never seen Manyfold: say why they are here and that approving comes
    // next, since the sign-in form alone reads like any other login.
    const forAgent = redirectUrl.startsWith('/cli-login')

    return (
        <div className='login-shell text-fg flex min-h-screen flex-col px-5 py-5 md:px-8'>
            <SignedIn>
                <Navigate to={redirectUrl} replace />
            </SignedIn>

            <header className='mx-auto flex w-full max-w-5xl items-center justify-between gap-3'>
                <Link
                    to='/'
                    aria-label={t('common.appName')}
                    className='text-fg inline-flex items-center gap-1 text-[19px] font-medium tracking-[-0.015em] transition-opacity hover:opacity-80'
                >
                    <BrandMark className='block h-7 w-auto' />
                    <span>{t('common.appName')}</span>
                </Link>
                <PreferenceControls />
            </header>

            <main className='flex flex-1 items-center justify-center py-10'>
                <div className='w-full max-w-[28rem]'>
                    {forAgent && (
                        <div className='workbench-note mb-3 flex items-start gap-3'>
                            <SquareTerminal
                                aria-hidden='true'
                                className='mt-0.5 h-4 w-4 shrink-0'
                            />
                            <div className='min-w-0'>
                                <p className='text-fg font-medium'>
                                    {t('web.auth.agentConnectTitle')}
                                </p>
                                <p className='mt-0.5'>
                                    {t('web.auth.agentConnectBody')}
                                </p>
                            </div>
                        </div>
                    )}
                    <AuthSignIn
                        path='/login'
                        redirectUrl={redirectUrl}
                        initialMode={isInvite ? 'sign-up' : 'sign-in'}
                        lockMode={isInvite}
                        prefillEmail={inviteEmail}
                    />
                </div>
            </main>
        </div>
    )
}

export default Login
