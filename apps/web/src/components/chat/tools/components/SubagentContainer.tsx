import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import EmptyState from '@/components/EmptyState'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import type {
    PairedToolBlock,
    SubagentBlock as SubagentBlockType
} from '@/components/chat/utils/pairToolBlocks'
import ToolBlock from '@/components/chat/tools/ToolBlock'
import ToolStatusBadge from '@/components/chat/tools/components/ToolStatusBadge'
import { useI18n } from '@/lib/i18n'

interface Props {
    block: SubagentBlockType
    compact?: boolean
}

const SubagentContainer: FC<Props> = ({
    block,
    compact = false
}): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(block.status === 'running')
    const args = (block.call.args ?? {}) as Record<string, unknown>
    const description =
        asStr(args.description) ||
        asStr(args.task) ||
        asStr(args.subagent_type) ||
        t('web.chat.tools.task')
    const subagentType = asStr(args.subagent_type)
    const elapsed = block.result?.elapsedMs ?? block.call.elapsedMs

    return (
        <div
            className={
                compact ? 'my-0.5' : 'shadow-ring my-2 rounded-md bg-white'
            }
        >
            <button
                type='button'
                onClick={() => setOpen(!open)}
                className={[
                    'flex w-full items-center gap-2 rounded-md text-left transition-colors',
                    compact
                        ? 'text-subtle hover:text-fg px-1 py-0.5'
                        : 'hover:bg-surface-subtle px-3 py-2'
                ].join(' ')}
            >
                {open ? (
                    <ChevronDownIcon
                        className={[
                            'h-3.5 w-3.5 shrink-0',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    />
                ) : (
                    <ChevronRightIcon
                        className={[
                            'h-3.5 w-3.5 shrink-0',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    />
                )}
                <Sparkles
                    className={[
                        'h-3.5 w-3.5 shrink-0',
                        compact ? 'text-current' : 'text-workflow-preview'
                    ].join(' ')}
                />
                <span
                    className={[
                        'text-caption font-mono',
                        compact ? 'text-current' : 'text-subtle'
                    ].join(' ')}
                >
                    {t('web.chat.tools.subagent')}
                </span>
                <ShortcutTooltip label={description} className='min-w-0 flex-1'>
                    <span
                        className={[
                            'text-ui w-full truncate',
                            compact ? 'text-current' : 'text-fg'
                        ].join(' ')}
                    >
                        {description}
                    </span>
                </ShortcutTooltip>
                {subagentType && (
                    <span
                        className={[
                            'text-caption hidden font-mono sm:inline',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    >
                        {subagentType}
                    </span>
                )}
                {block.children.length > 0 && (
                    <span
                        className={[
                            'text-caption font-mono',
                            compact ? 'text-current' : 'text-subtle'
                        ].join(' ')}
                    >
                        {block.children.length}{' '}
                        {t(
                            block.children.length === 1
                                ? 'web.chat.tools.step'
                                : 'web.chat.tools.steps'
                        )}
                    </span>
                )}
                <ToolStatusBadge status={block.status} elapsedMs={elapsed} />
            </button>
            {open && (
                <div
                    className={
                        compact
                            ? 'px-6 py-1'
                            : 'border-divider border-t px-3 py-2'
                    }
                >
                    {block.children.length === 0 ? (
                        block.status === 'running' ? (
                            <div className='text-caption text-subtle font-mono'>
                                {t('web.chat.tools.working')}
                            </div>
                        ) : (
                            <EmptyState
                                kind='all-clear'
                                tier='line'
                                subtle
                                mono
                                body={t('web.chat.tools.noRecordedSteps')}
                            />
                        )
                    ) : (
                        <div className='border-divider border-l-2 pl-2.5'>
                            {block.children.map((child, idx) => (
                                <SubagentChild
                                    key={`${child.call.toolCallId}-${idx}`}
                                    child={child}
                                    compact={compact}
                                />
                            ))}
                        </div>
                    )}
                    {block.result && (
                        <SubagentSummary result={block.result.result} />
                    )}
                </div>
            )}
        </div>
    )
}

const SubagentChild: FC<{ child: PairedToolBlock; compact: boolean }> = ({
    child,
    compact
}) => (
    <ToolBlock
        call={child.call}
        result={child.result}
        status={child.status}
        compact={compact}
    />
)

const SubagentSummary: FC<{ result: unknown }> = ({ result }) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const text = extractSummaryText(result)
    if (!text) return null
    return (
        <div className='mt-2'>
            <button
                type='button'
                onClick={() => setOpen(!open)}
                className='text-caption text-subtle hover:text-fg font-mono'
            >
                {open ? '−' : '+'} {t('web.chat.tools.summary')}
            </button>
            {open && (
                <pre className='text-caption text-fg mt-1.5 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono'>
                    {text}
                </pre>
            )}
        </div>
    )
}

const extractSummaryText = (raw: unknown): string => {
    if (raw == null) return ''
    if (typeof raw === 'string') return raw
    if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>
        if (typeof obj.content === 'string') return obj.content
        if (Array.isArray(obj.content)) {
            return (obj.content as Array<Record<string, unknown>>)
                .map((c) => (typeof c?.text === 'string' ? c.text : ''))
                .join('\n')
        }
    }
    try {
        return JSON.stringify(raw, null, 2)
    } catch {
        return String(raw)
    }
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

export default SubagentContainer
