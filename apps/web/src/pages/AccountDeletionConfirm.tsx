import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import { SignedIn, SignedOut } from '@/lib/auth'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/errorMessage'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { formatDate } from '@/lib/dateFormat'

// The emailed confirmation link lands here (ADR-0023 §9.1). The token proves
// inbox possession; the session proves the account — so a signed-out click
// bounces through login and returns with the token intact, GrantPermission
// style. Confirming is an explicit button press: a destructive action must
// never fire just because a link was opened (or prefetched).
const AccountDeletionConfirm: FC = (): ReactNode => {
    const location = useLocation()
    return (
        <>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
            </SignedOut>
            <SignedIn>
                <ConfirmContent />
            </SignedIn>
        </>
    )
}

const ConfirmContent: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [params] = useSearchParams()
    const token = params.get('token') ?? ''
    const [busy, setBusy] = useState(false)
    const [scheduledAt, setScheduledAt] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const confirm = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const status = await client.meDeletion.confirm(token)
            setScheduledAt(status.scheduledAt)
        } catch (err) {
            setError(
                err instanceof ApiError && err.status === 400
                    ? t('web.accountDeletion.linkInvalid')
                    : apiErrorMessage(err)
            )
        } finally {
            setBusy(false)
        }
    }

    if (scheduledAt) {
        return (
            <Shell title={t('web.accountDeletion.confirmedTitle')}>
                <p className='text-muted text-ui'>
                    {t('web.accountDeletion.confirmedBody', {
                        date: formatDate(scheduledAt)
                    })}
                </p>
            </Shell>
        )
    }

    return (
        <Shell title={t('web.accountDeletion.confirmTitle')}>
            {token ? (
                <>
                    <p className='text-muted text-ui'>
                        {t('web.accountDeletion.confirmBody')}
                    </p>
                    <p className='text-muted text-ui'>
                        {t('web.accountDeletion.confirmRestoreHint')}
                    </p>
                    {error && (
                        <p className='text-error text-ui' role='alert'>
                            {error}
                        </p>
                    )}
                    <button
                        type='button'
                        className='workbench-button-danger'
                        disabled={busy}
                        onClick={() => void confirm()}
                    >
                        {busy
                            ? t('web.accountDeletion.confirmBusy')
                            : t('web.accountDeletion.confirmButton')}
                    </button>
                </>
            ) : (
                <p className='text-error text-ui' role='alert'>
                    {t('web.accountDeletion.missingToken')}
                </p>
            )}
        </Shell>
    )
}

const Shell: FC<{ title: string; children: ReactNode }> = ({
    title,
    children
}): ReactNode => (
    <div className='text-fg bg-main flex min-h-screen items-center justify-center px-5 py-10'>
        <main className='workbench-panel w-full max-w-[34rem] px-6 py-6'>
            <div className='space-y-5'>
                <h1 className='text-h1 text-fg'>{title}</h1>
                {children}
            </div>
        </main>
    </div>
)

export default AccountDeletionConfirm
