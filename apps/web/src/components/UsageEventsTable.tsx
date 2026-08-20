import type { UsageEventSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import {
    fmtCost,
    fmtTokens,
    formatDuration,
    formatTableDateTime
} from '@/lib/usageFormat'

const FALLBACK_PANEL_WIDTH = 264

// Ghost rows mirror the real 8-column grid (DESIGN.md §10.8): the header
// is chrome and stays real, numeric columns keep their right alignment,
// so the loaded table lands with zero column shift.
const ghostAgentWidth = ['w-24', 'w-16', 'w-20']
const ghostModelWidth = ['w-28', 'w-20', 'w-32']
const GHOST_EVENT_ROWS = [0, 1, 2, 3, 4, 5]

const FallbackModel: FC<{ model: string | null }> = ({ model }) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [pos, setPos] = useState<{ left: number; top: number }>({
        left: 0,
        top: 0
    })

    const updatePos = useCallback((): void => {
        const rect = btnRef.current?.getBoundingClientRect()
        if (typeof window === 'undefined' || !rect) return
        const left = Math.min(
            rect.left,
            window.innerWidth - FALLBACK_PANEL_WIDTH - 8
        )
        setPos({ left: Math.max(8, left), top: rect.bottom + 6 })
    }, [])

    useLayoutEffect(() => {
        if (!open) return
        updatePos()
        const handle = (): void => updatePos()
        window.addEventListener('resize', handle)
        window.addEventListener('scroll', handle, true)
        return () => {
            window.removeEventListener('resize', handle)
            window.removeEventListener('scroll', handle, true)
        }
    }, [open, updatePos])

    useEffect(() => {
        if (!open) return
        const onDown = (event: MouseEvent): void => {
            const target = event.target as Node
            if (
                !panelRef.current?.contains(target) &&
                !btnRef.current?.contains(target)
            )
                setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <>
            <button
                ref={btnRef}
                type='button'
                onClick={() => setOpen((v) => !v)}
                aria-haspopup='dialog'
                aria-expanded={open}
                className='text-warning hover:text-warning-strong cursor-pointer font-mono text-sm underline decoration-dotted underline-offset-2'
            >
                {model ?? '—'}
            </button>
            {open &&
                createPortal(
                    <div
                        ref={panelRef}
                        role='dialog'
                        aria-label={t('web.usage.fallbackModel')}
                        className='bg-surface-elevated shadow-elevated fixed z-[200] rounded-md p-3.5'
                        style={{
                            left: pos.left,
                            top: pos.top,
                            width: FALLBACK_PANEL_WIDTH
                        }}
                    >
                        <div className='text-ui text-warning font-medium'>
                            {t('web.usage.fallbackModel')}
                        </div>
                        <p className='text-caption text-muted mt-1.5 leading-relaxed'>
                            {t('web.usage.fallbackModelBody')}
                        </p>
                        <p className='text-caption text-muted mt-2 leading-relaxed'>
                            {t('web.usage.fallbackModelCost')}
                        </p>
                    </div>,
                    document.body
                )}
        </>
    )
}

interface Props {
    items: UsageEventSummary[]
    resolveAgentName: (agentId: string | null) => string
    loading?: boolean
    error?: string | null
}

const UsageEventsTable: FC<Props> = ({
    items,
    resolveAgentName,
    loading = false,
    error = null
}): ReactNode => {
    const { t } = useI18n()
    const showGhostRows = loading && items.length === 0
    return (
        <div className='workbench-table-shell' aria-busy={showGhostRows}>
            <div className='overflow-x-auto'>
                <table className='workbench-table min-w-[820px] whitespace-nowrap'>
                    <thead className='workbench-table-head'>
                        <tr className='text-caption text-muted uppercase tracking-wider'>
                            <th className='px-5 py-3 font-medium'>
                                {t('web.usage.time')}
                            </th>
                            <th className='px-5 py-3 font-medium'>
                                {t('web.usage.agent')}
                            </th>
                            <th className='px-5 py-3 font-medium'>
                                {t('web.usage.model')}
                            </th>
                            <th className='px-5 py-3 text-right font-medium'>
                                {t('web.usage.input')}
                            </th>
                            <th className='px-5 py-3 text-right font-medium'>
                                {t('web.usage.output')}
                            </th>
                            <th className='px-5 py-3 text-right font-medium'>
                                {t('web.usage.cacheReadWrite')}
                            </th>
                            <th className='px-5 py-3 text-right font-medium'>
                                {t('web.usage.cost')}
                            </th>
                            <th className='px-5 py-3 text-right font-medium'>
                                {t('web.usage.ttft')}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {showGhostRows &&
                            GHOST_EVENT_ROWS.map((row) => (
                                <tr
                                    key={`ghost-${row}`}
                                    className='border-t border-solid border-transparent shadow-[inset_0_1px_0_rgba(0,0,0,0.04)]'
                                >
                                    <td className='px-5 py-3'>
                                        <Ghost variant='cap' className='w-24' />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <span className='flex items-center gap-2'>
                                            <Ghost
                                                variant='circle'
                                                className='h-[18px] w-[18px] shrink-0'
                                            />
                                            <Ghost
                                                variant='cap'
                                                className={
                                                    ghostAgentWidth[row % 3]
                                                }
                                            />
                                        </span>
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className={ghostModelWidth[row % 3]}
                                        />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className='ml-auto w-12'
                                        />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className='ml-auto w-12'
                                        />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className='ml-auto w-16'
                                        />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className='ml-auto w-10'
                                        />
                                    </td>
                                    <td className='px-5 py-3'>
                                        <Ghost
                                            variant='cap'
                                            className='ml-auto w-10'
                                        />
                                    </td>
                                </tr>
                            ))}
                        {items.map((e) => (
                            <tr
                                key={e.id}
                                className='text-ui text-fg border-t border-solid border-transparent shadow-[inset_0_1px_0_rgba(0,0,0,0.04)]'
                            >
                                <td className='text-muted px-5 py-3 tabular-nums'>
                                    {formatTableDateTime(e.createdAt)}
                                </td>
                                <td className='px-5 py-3'>
                                    <span className='flex items-center gap-2'>
                                        <ShortcutTooltip
                                            label={frameworkLabel(e.framework)}
                                            className='shrink-0'
                                        >
                                            <FrameworkLogo
                                                framework={e.framework}
                                                size={18}
                                            />
                                        </ShortcutTooltip>
                                        {e.agentId ? (
                                            <Link
                                                to={`/agents/${e.agentId}/chat`}
                                                className='text-link hover:underline'
                                            >
                                                {resolveAgentName(e.agentId)}
                                            </Link>
                                        ) : (
                                            <span className='text-muted'>
                                                —
                                            </span>
                                        )}
                                    </span>
                                </td>
                                <td className='px-5 py-3'>
                                    {e.isFallbackModel ? (
                                        <FallbackModel model={e.model} />
                                    ) : (
                                        <span className='font-mono text-sm'>
                                            {e.model ?? '—'}
                                        </span>
                                    )}
                                </td>
                                <td className='px-5 py-3 text-right tabular-nums'>
                                    {fmtTokens(e.inputTokens)}
                                </td>
                                <td className='px-5 py-3 text-right tabular-nums'>
                                    {fmtTokens(e.outputTokens)}
                                </td>
                                <td className='text-muted px-5 py-3 text-right tabular-nums'>
                                    {fmtTokens(e.cacheReadTokens)} /{' '}
                                    {fmtTokens(e.cacheCreationTokens)}
                                </td>
                                <td className='px-5 py-3 text-right tabular-nums'>
                                    {e.costUsd !== null &&
                                    e.costSource === 'table' ? (
                                        <ShortcutTooltip
                                            label={t('web.usage.estimatedCost')}
                                            placement='bottom-end'
                                        >
                                            <span className='text-muted'>
                                                ~{fmtCost(e.costUsd)}
                                            </span>
                                        </ShortcutTooltip>
                                    ) : (
                                        fmtCost(e.costUsd)
                                    )}
                                </td>
                                <td className='text-muted px-5 py-3 text-right tabular-nums'>
                                    {e.firstTokenMs !== null
                                        ? formatDuration(e.firstTokenMs)
                                        : '—'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {items.length === 0 && !loading && !error && (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    frame={false}
                    title={t('web.emptyState.usageEventsTitle')}
                    body={t('web.emptyState.usageEventsBody')}
                />
            )}
        </div>
    )
}

export default UsageEventsTable
