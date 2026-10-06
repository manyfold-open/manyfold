import type { RefObject } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { agentSetupTarget, buildAgentSetupPrompt } from '@/lib/agentSetupPrompt'
import { apiBaseUrl } from '@/lib/apiClient'
import { useI18n } from '@/lib/i18n'

const COPIED_RESET_MS = 1500

export interface AgentSetupPrompt {
    prompt: string
    guideUrl: string
    promptRef: RefObject<HTMLParagraphElement>
    copied: boolean
    copy: () => Promise<void>
}

// The copyable prompt behind every "use Manyfold in your agent" entry, so the
// workspace dialog and the landing CTA hand out the same text.
export const useAgentSetupPrompt = (): AgentSetupPrompt => {
    const { t } = useI18n()
    const target = useMemo(() => agentSetupTarget(apiBaseUrl()), [])
    const prompt = useMemo(() => buildAgentSetupPrompt(t, target), [t, target])
    const [copied, setCopied] = useState(false)
    const promptRef = useRef<HTMLParagraphElement>(null)

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

    return { prompt, guideUrl: target.guideUrl, promptRef, copied, copy }
}
