import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { ClaudeCodeColor, CodexColor } from '@/lib/brandIcons'
import { useI18n } from '@/lib/i18n'
import { useAgentSetupPrompt } from '@/lib/useAgentSetupPrompt'

const FAILED_RESET_MS = 4000

// The hero's second door: one click puts the same prompt the workspace's
// "Use Manyfold in your agent" dialog hands out on the clipboard, and the
// button itself says what to do next. Where the clipboard is unavailable it
// turns into a link to the guide instead of pretending it copied.
const UseInAgentCta: FC = (): ReactNode => {
    const { t } = useI18n()
    const { guideUrl, copied, copy } = useAgentSetupPrompt()
    const [failed, setFailed] = useState(false)
    const state = copied ? 'copied' : failed ? 'failed' : 'idle'

    useEffect(() => {
        if (!failed) return
        const timer = window.setTimeout(() => setFailed(false), FAILED_RESET_MS)
        return () => window.clearTimeout(timer)
    }, [failed])

    const onClick = async (): Promise<void> => {
        if (failed) {
            window.open(guideUrl, '_blank', 'noopener,noreferrer')
            return
        }
        setFailed(!(await copy()))
    }

    return (
        <button
            type='button'
            className='lp-btn lp-btn-secondary lp-agent'
            data-state={state}
            onClick={() => {
                void onClick()
            }}
        >
            <span className='lp-agent-marks' aria-hidden='true'>
                <ClaudeCodeColor size={16} />
                <CodexColor size={16} />
            </span>
            <span className='lp-agent-label' aria-live='polite'>
                <span aria-hidden={state !== 'idle'}>
                    {t('web.landing.useInAgentCta')}
                </span>
                <span
                    className='lp-agent-done'
                    aria-hidden={state !== 'copied'}
                >
                    {t('web.landing.useInAgentPaste')}
                </span>
                <span
                    className='lp-agent-fail'
                    aria-hidden={state !== 'failed'}
                >
                    {t('web.landing.useInAgentFailed')}
                </span>
            </span>
            <span className='lp-agent-ico' aria-hidden='true'>
                <Copy />
                <Check />
            </span>
        </button>
    )
}

export default UseInAgentCta
