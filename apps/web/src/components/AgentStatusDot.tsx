import type { FC, ReactNode } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useIsAgentStreaming } from '@/lib/chatStreamStore'
import { agentStatusDotClass, agentStatusDotLabel } from '@/lib/agentStatusDot'

interface Props {
    agent: SdkAgent
    size?: 'sm' | 'md'
    tone?: string
}

const SIZE_CLASS: Record<NonNullable<Props['size']>, string> = {
    sm: 'h-1.5 w-1.5',
    md: 'h-2 w-2'
}

const AgentStatusDot: FC<Props> = ({
    agent,
    size = 'sm',
    tone
}): ReactNode => {
    const streaming = useIsAgentStreaming(agent.id)
    const dim = SIZE_CLASS[size]
    const color =
        tone ??
        agentStatusDotClass(
            agent.status,
            agent.spriteStatus,
            agent.k8sPodPhase,
            agent.runtime
        )
    const baseLabel = agentStatusDotLabel(
        agent.status,
        agent.spriteStatus,
        agent.k8sPodPhase
    )
    const label = streaming ? `${baseLabel} · streaming` : baseLabel
    return (
        <ShortcutTooltip label={label} className='shrink-0'>
            <span
                className={`relative inline-flex ${dim} shrink-0`}
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

export default AgentStatusDot
