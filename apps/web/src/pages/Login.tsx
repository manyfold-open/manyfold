import { type FC, type ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { BrandMark } from '@/components/Brand'
import { PreferenceControls } from '@/components/PreferenceControls'
import { AuthSignIn, SignedIn } from '@/lib/auth'
import { useI18n } from '@/lib/i18n'

const Login: FC = (): ReactNode => {
    const { t } = useI18n()
    const [params] = useSearchParams()
    const redirectUrl = safeRedirect(params.get('redirect_url')) ?? '/workspace'
    // Invite-redemption links land here pre-marked for sign-up with the
    // invited email locked in; everyone else gets the plain sign-in form.
    const isInvite = params.get('invite') === 'true'
    const inviteEmail = params.get('email')?.trim() || undefined

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

// Internal paths only. The absolute-URL allowance (and the `rd` parameter it
// served) existed for the k8s hermes dashboard's nginx auth-signin bounce,
// which was removed; every in-app producer passes a path, and rejecting the
// rest closes an open-redirect-shaped door.
const safeRedirect = (value: string | null): string | null => {
    if (!value) return null
    if (value.startsWith('/') && !value.startsWith('//')) return value
    return null
}

export default Login
