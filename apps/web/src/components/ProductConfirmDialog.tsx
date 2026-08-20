import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { useI18n } from '@/lib/i18n'

interface ProductConfirmOptions {
    title: ReactNode
    description: ReactNode
    confirmLabel?: string
    cancelLabel?: string
    tone?: 'default' | 'danger'
    // High-stakes gate: confirm stays disabled until the user types this
    // exact string (e.g. the resource name being destroyed).
    requireMatch?: string
}

interface ProductConfirmRequest extends ProductConfirmOptions {
    resolve: (confirmed: boolean) => void
}

export const useProductConfirm = (): {
    confirm: (options: ProductConfirmOptions) => Promise<boolean>
    confirmDialog: ReactNode
} => {
    const [request, setRequest] = useState<ProductConfirmRequest | null>(null)
    const [matchInput, setMatchInput] = useState('')
    const { t } = useI18n()

    const confirm = useCallback(
        (options: ProductConfirmOptions): Promise<boolean> =>
            new Promise((resolve) => {
                setMatchInput('')
                setRequest({ ...options, resolve })
            }),
        []
    )

    const close = (confirmed: boolean): void => {
        if (!request) return
        const resolve = request.resolve
        setRequest(null)
        resolve(confirmed)
    }

    const confirmDialog = request ? (
        <ProductDialog
            title={request.title}
            size='sm'
            onClose={() => close(false)}
            bodyClassName='text-ui text-muted'
            footer={
                <>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        onClick={() => close(false)}
                    >
                        {request.cancelLabel ?? t('common.cancel')}
                    </button>
                    <button
                        type='button'
                        className={
                            request.tone === 'danger'
                                ? 'workbench-button-danger'
                                : 'workbench-button-primary'
                        }
                        disabled={
                            !!request.requireMatch &&
                            matchInput !== request.requireMatch
                        }
                        onClick={() => close(true)}
                    >
                        {request.confirmLabel ?? t('common.confirm')}
                    </button>
                </>
            }
        >
            {request.description}
            {request.requireMatch && (
                <div className='mt-4'>
                    <label className='text-caption text-subtle block'>
                        {t('common.typeToConfirmPrefix')}{' '}
                        <code className='text-fg font-mono'>
                            {request.requireMatch}
                        </code>{' '}
                        {t('common.typeToConfirmSuffix')}
                    </label>
                    <input
                        value={matchInput}
                        onChange={(e) => setMatchInput(e.target.value)}
                        className='workbench-input mt-2 w-full font-mono'
                        spellCheck={false}
                        autoComplete='off'
                        autoFocus
                    />
                </div>
            )}
        </ProductDialog>
    ) : null

    return { confirm, confirmDialog }
}
