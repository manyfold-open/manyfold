import type { FC } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { NetmindSignIn } from '@/components/NetmindSignIn'
import { useI18n } from '@/lib/i18n'

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
            <NetmindSignIn onToken={onToken} submitLabel={submitLabel} />
        </ProductDialog>
    )
}
