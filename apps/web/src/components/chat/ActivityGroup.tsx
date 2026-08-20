import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import CapabilityBlock from '@/components/chat/CapabilityBlock'
import ThinkingBlock from '@/components/chat/ThinkingBlock'
import ToolBlock from '@/components/chat/tools/ToolBlock'
import SubagentContainer from '@/components/chat/tools/components/SubagentContainer'
import ToolStatusBadge from '@/components/chat/tools/components/ToolStatusBadge'
import type { ToolStatus } from '@/components/chat/utils/pairToolBlocks'
import type {
    ActivityRenderable,
    RenderableGroup
} from '@/components/chat/utils/groupRenderableBlocks'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

interface Props {
    group: Extract<RenderableGroup, { kind: 'activity-run' }>
    streaming?: boolean
}

const AUTO_CLOSE_MS = 1000

const ActivityGroup: FC<Props> = ({ group, streaming = false }): ReactNode => {
    const { t } = useI18n()
    const displayStatus =
        streaming && group.status === 'completed' ? 'running' : group.status
    const [open, setOpen] = useState(displayStatus === 'running')
    const [userToggled, setUserToggled] = useState(false)
    const wasRunning = useRef(displayStatus === 'running')

    useEffect(() => {
        if (displayStatus === 'running' && !userToggled) setOpen(true)
    }, [displayStatus, userToggled])

    useEffect(() => {
        if (wasRunning.current && displayStatus !== 'running' && !userToggled) {
            const id = setTimeout(() => setOpen(false), AUTO_CLOSE_MS)
            wasRunning.current = false
            return () => clearTimeout(id)
        }
        wasRunning.current = displayStatus === 'running'
    }, [displayStatus, userToggled])

    const onToggle = (): void => {
        setUserToggled(true)
        setOpen(!open)
    }

    return (
        <div className='my-0.5'>
            <button
                type='button'
                onClick={onToggle}
                aria-expanded={open}
                className='text-subtle hover:text-fg group flex max-w-full items-center gap-2 rounded-md py-1 pr-2 text-left transition-colors'
            >
                <ShortcutTooltip
                    label={group.summary.label}
                    className='min-w-0'
                >
                    <span
                        className={[
                            'text-ui w-full truncate text-current',
                            displayStatus === 'running' ? 'chat-shiny-text' : ''
                        ].join(' ')}
                    >
                        {t('web.chat.process', { label: group.summary.label })}
                    </span>
                </ShortcutTooltip>
                {open ? (
                    <ChevronDownIcon className='h-3.5 w-3.5 shrink-0 text-current' />
                ) : (
                    <ChevronRightIcon className='h-3.5 w-3.5 shrink-0 text-current' />
                )}
                {(displayStatus === 'error' || displayStatus === 'denied') && (
                    <ToolStatusBadge status={displayStatus} />
                )}
            </button>
            {open && (
                <div className='border-divider/80 ml-2 border-l py-1 pl-4'>
                    <div className='flex flex-col gap-0.5'>
                        {group.blocks.map((block, idx) => (
                            <ActivityItem
                                key={`${activityKey(block)}-${idx}`}
                                block={block}
                                status={displayStatus}
                                streaming={
                                    streaming && idx === group.blocks.length - 1
                                }
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

const ActivityItem: FC<{
    block: ActivityRenderable
    status: ToolStatus
    streaming: boolean
}> = ({ block, status, streaming }): ReactNode => {
    const { t } = useI18n()
    if (block.kind === 'thinking')
        return (
            <ThinkingBlock
                text={block.block.text}
                streaming={streaming && status === 'running'}
                compact
            />
        )
    if (block.kind === 'paired_tool')
        return (
            <ToolBlock
                call={block.call}
                result={block.result}
                status={block.status}
                compact
            />
        )
    if (block.kind === 'subagent')
        return <SubagentContainer block={block} compact />
    return (
        <CapabilityBlock
            label={t('web.chat.result')}
            body={
                <pre className='whitespace-pre-wrap'>
                    {JSON.stringify(block.result.result, null, 2)}
                </pre>
            }
        />
    )
}

const activityKey = (block: ActivityRenderable): string => {
    if (block.kind === 'thinking') return `thinking-${block.block.text.length}`
    if (block.kind === 'paired_tool') return block.call.toolCallId
    if (block.kind === 'subagent') return block.call.toolCallId
    return block.result.toolCallId
}

export default ActivityGroup
