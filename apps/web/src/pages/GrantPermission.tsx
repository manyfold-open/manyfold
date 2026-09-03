import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import {
    Navigate,
    useLocation,
    useNavigate,
    useSearchParams
} from 'react-router-dom'
import { SignedIn, SignedOut } from '@/lib/auth'
import PermissionConsent, {
    type PermissionConsentGranted
} from '@/components/permissions/PermissionConsent'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { useI18n } from '@/lib/i18n'

const GrantPermission: FC = (): ReactNode => {
    const location = useLocation()
    const [params] = useSearchParams()

    return (
        <>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
            </SignedOut>
            <SignedIn>
                <GrantPermissionContent token={params.get('token') ?? ''} />
            </SignedIn>
        </>
    )
}

const GrantPermissionContent: FC<{ token: string }> = ({
    token
}): ReactNode => {
    const navigate = useNavigate()
    const { t } = useI18n()
    const [granted, setGranted] = useState<PermissionConsentGranted | null>(
        null
    )

    const dismiss = (): void => {
        navigate('/workspace', { replace: true })
    }

    if (granted) {
        const count = granted.approvedScopes.length
        return (
            <Shell>
                <div className='border-success/40 bg-success-bg text-success text-ui shadow-ring-light rounded-md border px-3.5 py-3'>
                    <p className='text-fg font-medium'>
                        {t('web.permissions.granted', {
                            count,
                            capability: t(
                                count === 1
                                    ? 'web.permissions.capability'
                                    : 'web.permissions.capabilities'
                            ),
                            name: granted.agentName
                        })}
                    </p>
                    <p className='text-muted text-ui mt-1'>
                        {t('web.permissions.grantDoneHint')}
                    </p>
                </div>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    onClick={dismiss}
                >
                    {t('web.a2aGrant.done')}
                </button>
            </Shell>
        )
    }

    return (
        <Shell>
            <PermissionConsent
                token={token}
                onGranted={setGranted}
                onDenied={dismiss}
                onDismiss={dismiss}
            />
        </Shell>
    )
}

const Shell: FC<{ children: ReactNode }> = ({ children }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='text-fg bg-main flex min-h-screen items-center justify-center px-5 py-10'>
            <main className='workbench-panel w-full max-w-[34rem] px-6 py-6'>
                <div className='space-y-5'>
                    <div>
                        <h1 className='text-h1 text-fg'>
                            {t('web.permissions.pageTitle')}
                        </h1>
                        <p className='text-muted text-ui mt-1'>
                            {t('web.permissions.pageSubtitle')}
                        </p>
                    </div>
                    {children}
                </div>
            </main>
        </div>
    )
}

export default GrantPermission
