import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import DialogPage from '@/components/DialogPage'
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
            <DialogPage
                title={t('web.accountDeletion.confirmedTitle')}
                description={t('web.accountDeletion.confirmedBody', {
                    date: formatDate(scheduledAt)
                })}
            />
        )
    }

    if (!token) {
        return (
            <DialogPage title={t('web.accountDeletion.confirmTitle')}>
                <div className='workbench-alert-error' role='alert'>
                    {t('web.accountDeletion.missingToken')}
                </div>
            </DialogPage>
        )
    }

    return (
        <DialogPage
            title={t('web.accountDeletion.confirmTitle')}
            description={t('web.accountDeletion.confirmBody')}
            actions={
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
            }
        >
            <p className='text-muted text-ui'>
                {t('web.accountDeletion.confirmRestoreHint')}
            </p>
            {error && (
                <div className='workbench-alert-error' role='alert'>
                    {error}
                </div>
            )}
        </DialogPage>
    )
}

export default AccountDeletionConfirm
