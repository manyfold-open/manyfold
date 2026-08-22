import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError } from '@manyfold/sdk'
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

    return (
        <div className='text-fg bg-main flex min-h-screen items-center justify-center px-5 py-10'>
            <main className='workbench-panel w-full max-w-[34rem] px-6 py-6'>
                <div className='space-y-5'>
                    <h1 className='text-h2'>
                        {restored
                            ? t('web.accountDeletion.restoredTitle')
                            : t('web.accountDeletion.restoreTitle')}
                    </h1>
                    {restored ? (
                        <>
                            <p className='text-muted text-ui'>
                                {t('web.accountDeletion.restoredBody')}
                            </p>
                            <Link
                                to='/login'
                                className='workbench-button-primary inline-flex'
                            >
                                {t('web.accountDeletion.goToSignIn')}
                            </Link>
                        </>
                    ) : token ? (
                        <>
                            <p className='text-muted text-ui'>
                                {t('web.accountDeletion.restoreBody')}
                            </p>
                            {error && (
                                <p className='text-error text-ui' role='alert'>
                                    {error}
                                </p>
                            )}
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
                        </>
                    ) : (
                        <p className='text-error text-ui' role='alert'>
                            {t('web.accountDeletion.missingToken')}
                        </p>
                    )}
                </div>
            </main>
        </div>
    )
}

export default AccountDeletionRestore
