import type { FC, ReactNode } from 'react'
import type { TagTone } from '@/components/Tag'
import { tagToneClass } from '@/components/Tag'
import { useI18n } from '@/lib/i18n'

// When an edit takes hold differs per section — a model swap is live at once, a
// skill lands on the agent's next turn, an env var waits for a restart — and it
// used to be buried in body copy or discovered after the fact. Every section
// states it in the same spot, so the cost of a change is legible before you
// make it. Toned but dot-less: this is a fixed property of the section, not a
// live state (DESIGN.md §10.6).
export type EffectTiming =
    | 'immediate'
    | 'next-turn'
    | 'next-request'
    | 'restart'

const TIMING: Record<EffectTiming, { key: string; tone: TagTone }> = {
    immediate: { key: 'web.agentSettings.timing.immediate', tone: 'idle' },
    'next-turn': { key: 'web.agentSettings.timing.nextTurn', tone: 'info' },
    'next-request': {
        key: 'web.agentSettings.timing.nextRequest',
        tone: 'info'
    },
    restart: { key: 'web.agentSettings.timing.restart', tone: 'warning' }
}

// Standalone so a section that already owns a bespoke header (most of them do,
// with their own explanatory copy) can adopt the signal without giving up its
// layout.
export const EffectTimingTag: FC<{ timing: EffectTiming }> = ({
    timing
}): ReactNode => {
    const { t } = useI18n()
    const chip = TIMING[timing]
    return (
        <span className={`tag ${tagToneClass[chip.tone]} shrink-0`}>
            {t(chip.key)}
        </span>
    )
}
