import type { FC, ReactNode } from 'react'
import {
    BookOpen,
    File as FileIcon,
    FilePlus,
    FileText,
    Globe,
    ListTodo,
    Pencil,
    Search,
    Sparkles,
    Terminal as TerminalIcon,
    Wrench
} from 'lucide-react'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import type { ToolIcon } from '@/components/chat/tools/configs/toolConfigs'
import type { ToolStatus } from '@/components/chat/utils/pairToolBlocks'
import ToolStatusBadge from '@/components/chat/tools/components/ToolStatusBadge'

interface Props {
    icon: ToolIcon
    toolName: string
    summary: string
    secondary?: string
    status: ToolStatus
    elapsedMs?: number
    onClick?: () => void
    monoBody?: boolean
    compact?: boolean
}

const OneLineDisplay: FC<Props> = ({
    icon,
    toolName,
    summary,
    secondary,
    status,
    elapsedMs,
    onClick,
    monoBody = false,
    compact = false
}): ReactNode => {
    const Icon = pickIcon(icon)
    const Wrapper = onClick ? 'button' : 'div'
    return (
        <Wrapper
            type={onClick ? 'button' : undefined}
            onClick={onClick}
            className={[
                'flex w-full items-center gap-2 rounded-md text-left transition-colors',
                compact
                    ? `text-subtle px-1 py-0.5 ${onClick ? 'hover:text-fg' : ''}`
                    : `text-fg shadow-ring-light bg-surface-subtle px-3 py-1.5 ${onClick ? 'hover:bg-white' : ''}`
            ].join(' ')}
        >
            <Icon
                className={[
                    'h-3.5 w-3.5 shrink-0',
                    compact ? 'text-current' : 'text-muted'
                ].join(' ')}
            />
            <span
                className={[
                    'text-caption font-mono',
                    compact
                        ? 'text-current'
                        : 'text-subtle uppercase tracking-wider'
                ].join(' ')}
            >
                {toolName}
            </span>
            <ShortcutTooltip label={summary} className='min-w-0 flex-1'>
                <span
                    className={`${monoBody ? 'font-mono' : ''} text-ui w-full truncate ${compact ? 'text-current' : 'text-fg'}`}
                >
                    {summary}
                </span>
            </ShortcutTooltip>
            {secondary && (
                <span
                    className={[
                        'text-caption hidden shrink-0 font-mono sm:inline',
                        compact ? 'text-current' : 'text-subtle'
                    ].join(' ')}
                >
                    {secondary}
                </span>
            )}
            <ToolStatusBadge status={status} elapsedMs={elapsedMs} />
        </Wrapper>
    )
}

const pickIcon = (icon: ToolIcon) => {
    switch (icon) {
        case 'read':
            return FileText
        case 'write':
            return FilePlus
        case 'edit':
            return Pencil
        case 'terminal':
            return TerminalIcon
        case 'search':
            return Search
        case 'glob':
            return FileIcon
        case 'task':
            return Sparkles
        case 'todo':
            return ListTodo
        case 'web':
            return Globe
        case 'plan':
            return BookOpen
        case 'tool':
        default:
            return Wrench
    }
}

export default OneLineDisplay
