import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { agentSetupTarget, buildAgentSetupPrompt } from '@/lib/agentSetupPrompt'
import { apiBaseUrl } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'

const COPIED_RESET_MS = 1500

const UseInAgentDialog: FC<{ onClose: () => void }> = ({
    onClose
}): ReactNode => {
    const { t } = useI18n()
    const prompt = useMemo(
        () => buildAgentSetupPrompt(t, agentSetupTarget(apiBaseUrl())),
        [t]
    )
    const [copied, setCopied] = useState(false)
    const promptRef = useRef<HTMLParagraphElement | null>(null)
    const copyRef = useRef<HTMLButtonElement | null>(null)

    useEffect(() => {
        copyRef.current?.focus()
    }, [])

    useEffect(() => {
        if (!copied) return
        const timer = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
        return () => window.clearTimeout(timer)
    }, [copied])

    // navigator.clipboard is missing on plain-http origins other than
    // localhost (a LAN or tailnet dev host); select the text so the user can
    // copy it by hand instead of claiming a copy that never happened.
    const selectPrompt = (): void => {
        const node = promptRef.current
        const selection = window.getSelection()
        if (!node || !selection) return
        const range = document.createRange()
        range.selectNodeContents(node)
        selection.removeAllRanges()
        selection.addRange(range)
    }

    const copy = async (): Promise<void> => {
        try {
            if (!navigator.clipboard) throw new Error('clipboard unavailable')
            await navigator.clipboard.writeText(prompt)
            setCopied(true)
        } catch {
            selectPrompt()
        }
    }

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
