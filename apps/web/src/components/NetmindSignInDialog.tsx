import { Suspense, type FC } from 'react'
import { ErrorBoundary } from '@sentry/react'
import ProductDialog from '@/components/ProductDialog'
import { useI18n } from '@/lib/i18n'
import { lazyChunk } from '@/lib/lazyChunk'

const SignIn = lazyChunk(async () => {
    const module = await import('@/components/NetmindSignIn')
    return { default: module.NetmindSignIn }
})

interface NetmindSignInDialogProps {
    title: string
    submitLabel: string
    description?: string
    // Resolve when the token is fully handled (logged in / bound). Throw to keep
    // the dialog open with the error shown inside.
    onToken: (loginToken: string) => Promise<void> | void
    onClose: () => void
}

// Modal that surfaces the NetMind login methods (email/password + OAuth) on
// demand, so a single "Sign in with NetMind" button can sit next to the Google
// button instead of spilling a whole form inline.
export const NetmindSignInDialog: FC<NetmindSignInDialogProps> = ({
    title,
    submitLabel,
    description,
    onToken,
    onClose
}) => {
    const { t } = useI18n()
    return (
        <ProductDialog
            title={title}
            description={description ?? t('web.auth.netmindDefaultDescription')}
            size='sm'
            onClose={onClose}
            bodyClassName='pb-5'
        >
            <ErrorBoundary
                fallback={() => (
                    <div role='alert' className='space-y-3'>
                        <p className='text-ui text-fg'>
                            {t('errors.appCrash.title')}
                        </p>
                        <button
                            type='button'
                            className='workbench-button-secondary'
                            onClick={() => window.location.reload()}
                        >
                            {t('errors.appCrash.reload')}
                        </button>
                    </div>
                )}
            >
                <Suspense
                    fallback={
                        <p role='status' className='text-ui text-muted'>
                            {t('common.loading')}
                        </p>
                    }
                >
                    <SignIn onToken={onToken} submitLabel={submitLabel} />
                </Suspense>
            </ErrorBoundary>
        </ProductDialog>
    )
}
