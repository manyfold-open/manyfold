import type {
    ChatToolCallBlock,
    ChatToolResultBlock
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import EmptyState from '@/components/EmptyState'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { ChevronDownIcon, ChevronRightIcon } from '@/components/icons'
import {
    extractResultText,
    type ToolStatus
} from '@/components/chat/utils/pairToolBlocks'
import {
    getToolConfig,
    type ToolDisplayConfig
} from '@/components/chat/tools/configs/toolConfigs'
import OneLineDisplay from '@/components/chat/tools/components/OneLineDisplay'
import ToolStatusBadge from '@/components/chat/tools/components/ToolStatusBadge'
import ToolDiffViewer from '@/components/chat/tools/components/ToolDiffViewer'
import { useI18n } from '@/lib/i18n'

interface Props {
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
    status: ToolStatus
    compact?: boolean
}

const ToolBlock: FC<Props> = ({
    call,
    result,
    status,
    compact = false
}): ReactNode => {
    const cfg = getToolConfig(call.toolName)
    const elapsed = result?.elapsedMs ?? call.elapsedMs

    if (cfg.input.type === 'one-line') {
        return (
            <OneLineToolBlock
                cfg={cfg}
                call={call}
                result={result}
                status={status}
                elapsedMs={elapsed}
                compact={compact}
            />
        )
    }

    if (cfg.input.type === 'todo-list') {
        return (
            <TodoToolBlock
                call={call}
                status={status}
                elapsedMs={elapsed}
                compact={compact}
            />
        )
    }

    return (
        <CollapsibleToolBlock
            cfg={cfg}
            call={call}
            result={result}
            status={status}
            elapsedMs={elapsed}
            compact={compact}
        />
    )
}

const OneLineToolBlock: FC<{
    cfg: ToolDisplayConfig
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
    status: ToolStatus
    elapsedMs?: number
    compact?: boolean
}> = ({ cfg, call, result, status, elapsedMs, compact = false }) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const summary = cfg.input.getSummary?.(call.args, t) ?? call.toolName
    const resultCfg = cfg.result
    const resultHidden =
        !result ||
        resultCfg?.type === 'hidden' ||
        (resultCfg?.hideOnSuccess && status === 'completed')

    return (
        <div className={compact ? 'my-0.5' : 'my-2'}>
            <OneLineDisplay
                icon={cfg.icon}
                toolName={call.toolName}
                summary={summary}
                status={status}
                elapsedMs={elapsedMs}
                onClick={resultHidden ? undefined : () => setOpen(!open)}
                monoBody={cfg.icon === 'terminal'}
                compact={compact}
            />
            {open && result && !resultHidden && (
                <div className={compact ? 'mt-1 pl-6' : 'mt-1.5'}>
                    <ResultBody cfg={cfg} result={result} />
                </div>
            )}
        </div>
    )
}

const CollapsibleToolBlock: FC<{
    cfg: ToolDisplayConfig
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
    status: ToolStatus
    elapsedMs?: number
    compact?: boolean
}> = ({ cfg, call, result, status, elapsedMs, compact = false }) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(cfg.input.defaultOpen ?? false)
    const summary =
        cfg.input.getSummary?.(call.args, t) ?? t('web.chat.tools.toolCall')
    return (
        <div
            className={
                compact
                    ? 'my-0.5'
                    : 'shadow-ring-light bg-surface-subtle my-2 rounded-md'
            }
        >
            <button
                type='button'
                onClick={() => setOpen(!open)}
                className={[
                    'flex w-full items-center gap-2 rounded-md text-left transition-colors',
                    compact
                        ? 'text-subtle hover:text-fg px-1 py-0.5'
                        : 'hover:bg-surface-hover px-3 py-1.5'
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
                <span
                    className={[
                        'text-caption shrink-0 font-mono',
                        compact
                            ? 'text-current'
                            : 'text-subtle'
                    ].join(' ')}
                >
                    {call.toolName}
                </span>
                <ShortcutTooltip label={summary} className='min-w-0 flex-1'>
                    <span
                        className={[
                            'text-ui w-full truncate',
                            compact ? 'text-current' : 'text-fg'
                        ].join(' ')}
                    >
                        {summary}
                    </span>
                </ShortcutTooltip>
                <ToolStatusBadge status={status} elapsedMs={elapsedMs} />
            </button>
            {open && (
                <div
                    className={
                        compact
                            ? 'px-6 py-1'
                            : 'border-divider border-t px-3 py-3'
                    }
                >
                    <CollapsibleBody cfg={cfg} call={call} result={result} />
                </div>
            )}
        </div>
    )
}

const CollapsibleBody: FC<{
    cfg: ToolDisplayConfig
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
}> = ({ cfg, call, result }) => {
    if (cfg.diff) {
        return <DiffBody cfg={cfg} call={call} />
    }
    return (
        <>
            <pre className='text-caption text-fg max-h-[40vh] overflow-auto whitespace-pre-wrap break-words font-mono'>
                {safeStringify(call.args)}
            </pre>
            {result && (
                <div className='border-divider mt-3 border-t pt-3'>
                    <ResultBody cfg={cfg} result={result} />
                </div>
            )}
        </>
    )
}

const DiffBody: FC<{ cfg: ToolDisplayConfig; call: ChatToolCallBlock }> = ({
    cfg,
    call
}) => {
    const { t } = useI18n()
    const a = call.args as Record<string, unknown>
    if (cfg.diff === 'edit-pair') {
        const oldText = asStr(a.old_string ?? a.old_str ?? a.before)
        const newText = asStr(a.new_string ?? a.new_str ?? a.after)
        return <ToolDiffViewer oldText={oldText} newText={newText} />
    }
    if (cfg.diff === 'multi-edit') {
        const edits = Array.isArray(a.edits) ? a.edits : []
        if (edits.length === 0) return <EmptyHint />
        return (
            <div className='flex flex-col gap-2'>
                {edits.map((e, i) => {
                    const eo = e as Record<string, unknown>
                    return (
                        <div key={i}>
                            <div className='text-caption text-subtle mb-1 font-mono'>
                                {t('web.chat.tools.editOf', {
                                    current: i + 1,
                                    total: edits.length
                                })}
                            </div>
                            <ToolDiffViewer
                                oldText={asStr(eo.old_string ?? eo.old_str)}
                                newText={asStr(eo.new_string ?? eo.new_str)}
                            />
                        </div>
                    )
                })}
            </div>
        )
    }
    if (cfg.diff === 'write-only') {
        const content = asStr(a.content ?? a.text ?? a.file_text)
        return <ToolDiffViewer newText={content} />
    }
    if (cfg.diff === 'unified-patch') {
        const patch = asStr(a.input ?? a.patch ?? a.diff)
        return <ToolDiffViewer unifiedPatch={patch} />
    }
    return <EmptyHint />
}

const ResultBody: FC<{
    cfg: ToolDisplayConfig
    result: ChatToolResultBlock
}> = ({ cfg, result }) => {
    const content = cfg.result?.contentType ?? 'json'
    const text = extractResultText(result.result)
    if (content === 'terminal') {
        return <TerminalOutput text={text} />
    }
    if (content === 'text' || content === 'markdown') {
        return (
            <pre className='text-caption text-fg max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono'>
                {text || ' '}
            </pre>
        )
    }
    if (content === 'file-list') {
        const files = parseFileList(text)
        if (files.length === 0) return <EmptyHint />
        return (
            <ul className='text-caption text-fg flex max-h-[50vh] flex-col gap-0.5 overflow-auto font-mono'>
                {files.map((f, i) => (
                    <li key={i} className='flex min-w-0'>
                        <ShortcutTooltip label={f} className='min-w-0'>
                            <span className='w-full truncate'>{f}</span>
                        </ShortcutTooltip>
                    </li>
                ))}
            </ul>
        )
    }
    return (
        <pre className='text-caption text-fg max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-mono'>
            {safeStringify(result.result)}
        </pre>
    )
}

const TodoToolBlock: FC<{
    call: ChatToolCallBlock
    status: ToolStatus
    elapsedMs?: number
    compact?: boolean
}> = ({ call, status, elapsedMs, compact = false }) => {
    const { t } = useI18n()
    const args = call.args as Record<string, unknown>
    const todos = Array.isArray(args.todos) ? args.todos : []
    return (
        <div
            className={
                compact
                    ? 'my-0.5 px-1 py-1'
                    : 'shadow-ring-light bg-surface-subtle my-2 rounded-md px-3 py-2.5'
            }
        >
            <div className='mb-2 flex items-center gap-2.5'>
                <span className='text-caption text-subtle font-mono'>
                    {call.toolName}
                </span>
                <span className='text-ui text-fg flex-1'>
                    {todos.length}{' '}
                    {t(
                        todos.length === 1
                            ? 'web.chat.tools.item'
                            : 'web.chat.tools.items'
                    )}
                </span>
                <ToolStatusBadge status={status} elapsedMs={elapsedMs} />
            </div>
            <ul className='flex flex-col gap-1'>
                {todos.map((t, i) => {
                    const o = t as Record<string, unknown>
                    const text =
                        typeof o.content === 'string'
                            ? o.content
                            : typeof o.text === 'string'
                              ? o.text
                              : ''
                    const tStatus = String(o.status ?? 'pending')
                    return (
                        <li key={i} className='text-ui flex items-start gap-2'>
                            <span
                                className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${todoDotColor(tStatus)}`}
                            />
                            <span
                                className={
                                    tStatus === 'completed'
                                        ? 'text-subtle line-through'
                                        : 'text-fg'
                                }
                            >
                                {text}
                            </span>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

const EmptyHint: FC = () => {
    const { t } = useI18n()
    return (
        <EmptyState
            kind='all-clear'
            tier='line'
            subtle
            mono
            body={t('web.chat.tools.noContent')}
        />
    )
}

const TERMINAL_LINE_CAP = 200

const TerminalOutput: FC<{ text: string }> = ({ text }) => {
    const { t } = useI18n()
    const [showAll, setShowAll] = useState(false)
    const lines = text.split('\n')
    const truncated = !showAll && lines.length > TERMINAL_LINE_CAP
    const visible = truncated
        ? lines.slice(lines.length - TERMINAL_LINE_CAP)
        : lines
    const hidden = lines.length - visible.length
    return (
        <div className='overflow-hidden rounded bg-[#0e0e0e]'>
            {truncated && (
                <button
                    type='button'
                    onClick={() => setShowAll(true)}
                    className='text-caption w-full border-b border-[#222] px-3 py-1.5 text-left font-mono text-[#9aa0a6] hover:text-[#e5e5e5]'
                >
                    {t('web.chat.tools.earlierLinesHidden', { count: hidden })}
                </button>
            )}
            <pre className='text-caption max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[#e5e5e5]'>
                {visible.join('\n') || ' '}
            </pre>
        </div>
    )
}

const todoDotColor = (s: string): string => {
    if (s === 'completed') return 'bg-[#0a8a3e]'
    if (s === 'in_progress') return 'bg-workflow-develop'
    return 'bg-divider'
}

const safeStringify = (v: unknown): string => {
    if (v == null) return ''
    if (typeof v === 'string') return v
    try {
        return JSON.stringify(v, null, 2)
    } catch {
        return String(v)
    }
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

const parseFileList = (text: string): string[] => {
    if (!text) return []
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
}

export default ToolBlock
