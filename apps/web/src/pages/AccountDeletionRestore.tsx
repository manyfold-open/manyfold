import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
import DialogPage from '@/components/DialogPage'
import { useApiClient } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'
import { apiErrorMessage } from '@/lib/errorMessage'

// The magic link from the T0 email lands here (ADR-0023 §9.1). Deliberately
// public: post-T0 every session is revoked and sign-in is blocked, so the
// signed single-use token is the whole credential. Restoring is an explicit
// button press, same reasoning as the confirm page.
const AccountDeletionRestore: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [params] = useSearchParams()
    const token = params.get('token') ?? ''
    const [busy, setBusy] = useState(false)
    const [restored, setRestored] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const restore = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            await client.meDeletion.restore(token)
            setRestored(true)
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

    if (restored) {
        return (
            <DialogPage
                title={t('web.accountDeletion.restoredTitle')}
                description={t('web.accountDeletion.restoredBody')}
                actions={
                    <Link
                        to='/login'
                        className='workbench-button-primary inline-flex'
                    >
                        {t('web.accountDeletion.goToSignIn')}
                    </Link>
                }
            />
        )
    }

    if (!token) {
        return (
            <DialogPage title={t('web.accountDeletion.restoreTitle')}>
                <div className='workbench-alert-error' role='alert'>
                    {t('web.accountDeletion.missingToken')}
                </div>
            </DialogPage>
        )
    }

    return (
        <DialogPage
            title={t('web.accountDeletion.restoreTitle')}
            description={t('web.accountDeletion.restoreBody')}
            actions={
                <button
                    type='button'
                    className='workbench-button-primary'
                    disabled={busy}
                    onClick={() => void restore()}
                >
                    {busy
                        ? t('web.accountDeletion.restoreBusy')
                        : t('web.accountDeletion.restoreButton')}
                </button>
            }
        >
            {error && (
                <div className='workbench-alert-error' role='alert'>
                    {error}
                </div>
            )}
        </DialogPage>
    )
}

export default AccountDeletionRestore
