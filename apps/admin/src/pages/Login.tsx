import type { FC, ReactNode } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import { AuthSignIn, SignedIn, useAppAuth } from '@/lib/auth'
import { safeRedirectPath } from '@/lib/loginRedirect'
import { adminRoutes } from '@/routes'

const Login: FC = (): ReactNode => {
    const auth = useAppAuth()
    const [params] = useSearchParams()
    const redirectUrl =
        safeRedirectPath(params.get('redirect_url')) ?? adminRoutes.dashboard
    if (auth.setupRequired)
        return <Navigate to={adminRoutes.setup} replace />

    return (
        <div className='flex min-h-screen flex-col items-center justify-center bg-white p-4'>
            <SignedIn>
                <Navigate to={redirectUrl} replace />
            </SignedIn>
            <div className='text-h3 text-heading mb-2 font-light tracking-tight'>
                {t('common.appName')}
            </div>
            <div className='w-full max-w-sm'>
                <AuthSignIn
                    path={adminRoutes.login}
                    redirectUrl={redirectUrl}
                />
            </div>
        </div>
    )
}

export default Login