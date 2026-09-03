import type {
    CSSProperties,
    FC,
    PointerEvent as ReactPointerEvent,
    ReactNode
} from 'react'
import {
    createContext,
    useCallback,
    useEffect,
    useRef,
    useState
} from 'react'
import { ChevronDownIcon, CloseIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

// A pane body can hand its own toolbar (e.g. the workspace file tabs) up into
// the shared header row beside the dropdown, instead of spending a second row
// on it. The active body portals into this element when the pane provides one.
export const SidePaneHeaderSlotContext = createContext<HTMLElement | null>(null)

// The one right-hand pane the chat exposes: background tasks, the workspace
// files (tree + preview), or the runtime session viewer — one at a time,
// picked from the header dropdown. Files brings its own two-column body and
// internal resize, so the pane only frames it; the single-column kinds get a
// pane-owned width + left-edge resize instead.
export type SidePaneKind = 'background-tasks' | 'files' | 'runtime'

export interface SidePaneOption {
    kind: SidePaneKind
    label: string
    disabled?: boolean
}

interface SidePaneProps {
    activeKind: SidePaneKind
    options: SidePaneOption[]
    onSelectKind: (kind: SidePaneKind) => void
    onClose: () => void
    children: ReactNode
}

const MIN_WIDTH = 380
const MAX_WIDTH = 960
const DEFAULT_WIDTH = 560
// One width for the whole pane: the content behind the dropdown changes, but
// the frame does not move — switching panels never resizes the column.
const WIDTH_KEY = 'nca:side-pane-width'

const ICON_BTN =
    'text-muted hover:bg-surface-hover hover:text-fg inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-pill transition-colors'

const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max)

const readWidth = (): number => {
    try {
        const raw = window.localStorage.getItem(WIDTH_KEY)
        if (raw)
            return clamp(
                Number.parseInt(raw, 10) || DEFAULT_WIDTH,
                MIN_WIDTH,
                MAX_WIDTH
            )
    } catch {
        return DEFAULT_WIDTH
    }
    return DEFAULT_WIDTH
}

const PaneTitleDropdown: FC<{
    activeKind: SidePaneKind
    options: SidePaneOption[]
    onSelect: (kind: SidePaneKind) => void
    ariaLabel: string
}> = ({ activeKind, options, onSelect, ariaLabel }): ReactNode => {
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDocClick = (event: MouseEvent): void => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node))
                setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    const active = options.find((option) => option.kind === activeKind)

    return (
        <div ref={rootRef} className='relative shrink-0'>
            <button
                type='button'
                aria-haspopup='menu'
                aria-expanded={open}
                aria-label={ariaLabel}
                onClick={() => setOpen((value) => !value)}
                className='text-fg hover:bg-surface-hover text-ui flex min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 font-medium transition-colors'
            >
                <span className='min-w-0 truncate'>{active?.label ?? ''}</span>
                <ChevronDownIcon className='h-3.5 w-3.5 shrink-0 opacity-70' />
            </button>
            {open && (
                <div
                    role='menu'
                    aria-label={ariaLabel}
                    className='popover-panel bg-surface-elevated shadow-elevated absolute left-0 top-full z-50 mt-1 w-56 rounded-md p-1'
                >
                    {options.map((option) => (
                        <button
                            key={option.kind}
                            type='button'
                            role='menuitem'
                            disabled={option.disabled}
                            onClick={() => {
                                if (option.disabled) return
                                setOpen(false)
                                onSelect(option.kind)
                            }}
                            className={[
                                'text-ui flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left transition-colors',
                                option.disabled
                                    ? 'text-muted cursor-not-allowed opacity-60'
                                    : option.kind === activeKind
                                      ? 'text-fg bg-soft'
                                      : 'text-fg hover:bg-soft'
                            ].join(' ')}
                        >
                            <span className='min-w-0 flex-1 truncate'>
                                {option.label}
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

const SidePane: FC<SidePaneProps> = ({
    activeKind,
    options,
    onSelectKind,
    onClose,
    children
}): ReactNode => {
    const { t } = useI18n()
    const [width, setWidth] = useState(readWidth)
    const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null)

    useEffect(() => {
        try {
            window.localStorage.setItem(WIDTH_KEY, String(width))
        } catch {
            // best-effort persistence
        }
    }, [width])

    const startResize = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>): void => {
            if (event.button !== 0) return
            event.preventDefault()
            const startX = event.clientX
            const startWidth = width
            const prevCursor = document.body.style.cursor
            const prevSelect = document.body.style.userSelect
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
            const onMove = (moveEvent: PointerEvent): void => {
                setWidth(
                    clamp(
                        startWidth - (moveEvent.clientX - startX),
                        MIN_WIDTH,
                        MAX_WIDTH
                    )
                )
            }
            const onUp = (): void => {
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
                window.removeEventListener('pointercancel', onUp)
                document.body.style.cursor = prevCursor
                document.body.style.userSelect = prevSelect
            }
            window.addEventListener('pointermove', onMove)
            window.addEventListener('pointerup', onUp)
            window.addEventListener('pointercancel', onUp)
        },
        [width]
    )

    const header = (
        <div className='border-divider/80 flex h-12 shrink-0 items-center gap-2 border-b px-3'>
            <PaneTitleDropdown
                activeKind={activeKind}
                options={options}
                onSelect={onSelectKind}
                ariaLabel={t('web.chat.pane.select')}
            />
            <div
                ref={setSlotEl}
                className='flex min-w-0 flex-1 items-center overflow-hidden'
            />
            <button
                type='button'
                onClick={onClose}
                aria-label={t('web.chat.pane.close')}
                className={ICON_BTN}
            >
                <CloseIcon className='h-4 w-4' />
            </button>
        </div>
    )

    return (
        <>
            <div
                role='separator'
                aria-orientation='vertical'
                aria-label={t('web.chat.pane.resize')}
                tabIndex={0}
                onPointerDown={startResize}
                className='group hidden w-2 shrink-0 cursor-col-resize items-stretch justify-center lg:flex'
            >
                <span className='group-hover:bg-placeholder group-focus-visible:bg-placeholder my-auto h-12 w-px rounded-full bg-transparent transition-colors' />
            </div>
            <aside
                aria-label={t('web.chat.pane.label')}
                style={{ '--side-pane-width': `${width}px` } as CSSProperties}
                className='border-divider/80 bg-main order-3 flex min-h-0 w-full flex-1 flex-col border-t lg:order-none lg:w-[var(--side-pane-width)] lg:flex-none lg:shrink-0 lg:border-l lg:border-t-0'
            >
                {header}
                <SidePaneHeaderSlotContext.Provider value={slotEl}>
                    <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
                        {children}
                    </div>
                </SidePaneHeaderSlotContext.Provider>
            </aside>
        </>
    )
}

export default SidePane
