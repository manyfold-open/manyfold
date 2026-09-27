import type { FC, ReactNode } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useIsAgentStreaming } from '@/lib/chatStreamStore'
import { agentStatusDotClass, agentStatusDotLabel } from '@/lib/agentStatusDot'

interface Props {
    agent: SdkAgent
    size?: 'sm' | 'md'
    tone?: string
    // Border-colour classes for a 2px ring in the surface behind the dot,
    // which is what keeps its edge off an icon it sits on. Outside the dot's
    // own size, so the colour reads the same with or without it.
    ring?: string
    tooltip?: boolean
}

const SIZE_CLASS: Record<NonNullable<Props['size']>, string> = {
    sm: 'h-1.5 w-1.5',
    md: 'h-2 w-2'
}

const AgentStatusDot: FC<Props> = ({
    agent,
    size = 'sm',
    tone,
    ring,
    tooltip = true
}): ReactNode => {
    const streaming = useIsAgentStreaming(agent.id)
    const dim = SIZE_CLASS[size]
    const color = tone ?? agentStatusDotClass(agent)
    const baseLabel = agentStatusDotLabel(agent)
    const label = streaming ? `${baseLabel} · streaming` : baseLabel
    return (
        <ShortcutTooltip
            label={label}
            className='shrink-0'
            disabled={!tooltip}
        >
            <span
                className={[
                    `relative inline-flex ${dim} shrink-0`,
                    ring === undefined
                        ? ''
                        : `box-content rounded-full border-2 transition-colors ${ring}`
                ].join(' ')}
                aria-hidden='true'
            >
                {streaming && (
                    <span className='bg-workflow-develop absolute inset-0 inline-flex animate-ping rounded-full opacity-75' />
                )}
                <span
                    className={`relative inline-flex ${dim} rounded-full ${color}`}
                />
            </span>
        </ShortcutTooltip>
    )
}

// An agent's icon with its status dot on the bottom-right corner, the way the
// collapsed rail already shows it: the state belongs to the agent, so it sits
// on the agent's face instead of trailing a name that may be truncated. The
// caller passes the ring the surface behind the icon calls for, hover
// included.
export const AgentIconStatus: FC<
    Props & { icon: ReactNode; ring: string }
> = ({ icon, ...dot }): ReactNode => (
    <span className='relative inline-flex shrink-0'>
        {icon}
        <span className='absolute -bottom-0.5 -right-0.5 inline-flex'>
            <AgentStatusDot {...dot} />
        </span>
    </span>
)

export default AgentStatusDot
