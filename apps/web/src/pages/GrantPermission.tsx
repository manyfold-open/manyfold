import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import {
    Navigate,
    useLocation,
    useNavigate,
    useSearchParams
} from 'react-router-dom'
import DialogPage from '@/components/DialogPage'
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
            <DialogPage
                title={t('web.permissions.granted', {
                    count,
                    capability: t(
                        count === 1
                            ? 'web.permissions.capability'
                            : 'web.permissions.capabilities'
                    ),
                    name: granted.agentName
                })}
                description={t('web.permissions.grantDoneHint')}
                actions={
                    <button
                        type='button'
                        className='workbench-button-primary'
                        onClick={dismiss}
                    >
                        {t('web.a2aGrant.done')}
                    </button>
                }
            />
        )
    }

    return (
        <DialogPage title={t('web.permissions.pageTitle')}>
            <PermissionConsent
                token={token}
                onGranted={setGranted}
                onDenied={dismiss}
                onDismiss={dismiss}
            />
        </DialogPage>
    )
}

export default GrantPermission
