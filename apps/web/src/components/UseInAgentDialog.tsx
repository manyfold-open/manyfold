import type { FC, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { useI18n } from '@/lib/i18n'
import { useAgentSetupPrompt } from '@/lib/useAgentSetupPrompt'

const UseInAgentDialog: FC<{ onClose: () => void }> = ({
    onClose
}): ReactNode => {
    const { t } = useI18n()
    const { prompt, promptRef, copied, copy } = useAgentSetupPrompt()
    const copyRef = useRef<HTMLButtonElement | null>(null)

    useEffect(() => {
        copyRef.current?.focus()
    }, [])

    return (
        <ProductDialog
            title={t('web.useInAgent.title')}
            description={t('web.useInAgent.description')}
            size='md'
            onClose={onClose}
            bodyClassName='flex flex-col gap-3'
            footer={
                <>
                    <p className='text-caption text-muted mr-auto'>
                        {t('web.useInAgent.hint')}
                    </p>
                    <button
                        ref={copyRef}
                        type='button'
                        onClick={() => {
                            void copy()
                        }}
                        className='workbench-button-primary text-ui h-9 shrink-0 px-4'
                    >
                        {copied ? t('common.copied') : t('common.copy')}
                    </button>
                </>
            }
        >
            <p
                ref={promptRef}
                dir='auto'
                className='bg-surface-subtle border-divider text-ui text-fg whitespace-pre-wrap break-words rounded-md border px-3 py-2.5'
            >
                {prompt}
            </p>
        </ProductDialog>
    )
}

export default UseInAgentDialog
