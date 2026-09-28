import type { AgentFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Spinner } from '@/components/Loading'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { statusTone, type TagTone } from '@/components/Tag'
import VersionPicker from '@/components/VersionPicker'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

// One framework a sandbox can hold: whether it is there, at which version,
// against the catalog, and who already runs it. The coding CLIs the sprite
// image ships install and upgrade in place; a service framework such as
// OpenClaw or Hermes is installed and started as an agent-less runtime, and
// upgraded through its first agent.
export interface HostFrameworkEntry {
    framework: AgentFramework
    label: string
    present: boolean
    // As the CLI reports it, parsed out of its `--version` line.
    version: string | null
    latest: string | null
    // The catalog's versions, newest first, to move to from the version.
    versions: readonly string[]
    // The newer version the Update Center has a row for, or null.
    update: string | null
    // Whether a version can be picked here at all (through the runtime's
    // agent, or in place for a CLI the image ships).
    changeable: boolean
    installable: boolean
    // The service framework already holding the sandbox's one public port,
    // when that is what makes this one uninstallable here.
    blockedBy: string | null
    // false = the sandbox was never probed, so a coding CLI's absence would be
    // a guess; the menu offers a check instead.
    probed: boolean
    // The agents already running this framework on the sandbox.
    agents: Array<{ id: string; name: string; status: string }>
}

export type HostFrameworkAction = 'check' | 'install' | 'upgrade'

// Literal class names on purpose: Tailwind only emits utilities it can see
// verbatim in the source (the Tag.tsx precedent).
const DOT_TONE: Record<TagTone, string> = {
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
    idle: 'bg-idle'
}

const iconClass = (open: boolean): string =>
    [
        'focus-visible:shadow-focus border-success/60 bg-surface hover:bg-surface-hover relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-[color,background-color,box-shadow,border-color] focus:outline-none',
        open ? 'bg-surface-hover' : ''
    ].join(' ')

// The menu behind one icon: the framework, its version on the product's
// version control (click it to move to another, the arrow to the Update
// Center when a newer one is out), and the agents that run it. Portalled and
// anchored like OverflowMenu so a card's rounded overflow cannot clip it.
const HostFrameworkMenu: FC<{
    entry: HostFrameworkEntry
    busy: boolean
    error: string | null
    onAction: (action: HostFrameworkAction, version?: string) => void
}> = ({ entry, busy, error, onAction }): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    // A press React routed through this menu, which includes the version
    // list: that one is portalled on its own, outside menuRef, and closing on
    // it would unmount the list before its click lands.
    const pressedInside = useRef(false)
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef, {
        align: 'start',
        matchAnchorWidth: false
    })
    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent): void => {
            const inside = pressedInside.current
            pressedInside.current = false
            const target = e.target as Node
            if (
                !inside &&
                !rootRef.current?.contains(target) &&
                !menuRef.current?.contains(target)
            )
                setOpen(false)
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDocClick)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDocClick)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    const icon = (
        <button
            type='button'
            aria-label={entry.label}
            aria-haspopup='menu'
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={iconClass(open)}
        >
            <FrameworkLogo framework={entry.framework} size={18} />
            {busy && (
                <span className='bg-surface absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full'>
                    <Spinner size={12} />
                </span>
            )}
            {!busy && entry.agents.length > 0 && (
                <span className='bg-surface text-subtle shadow-ring-light absolute -bottom-1 -right-1 rounded-sm px-0.5 text-[10px] tabular-nums leading-none'>
                    ×{entry.agents.length}
                </span>
            )}
        </button>
    )
    return (
        <div ref={rootRef} className='relative shrink-0'>
            {open ? (
                icon
            ) : (
                <ShortcutTooltip label={entry.label}>{icon}</ShortcutTooltip>
            )}
            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        role='menu'
                        aria-label={entry.label}
                        onMouseDown={() => {
                            pressedInside.current = true
                        }}
                        className={[
                            'popover-panel bg-surface-elevated shadow-elevated fixed z-[110] w-56 overflow-auto rounded-md p-1',
                            menuStyle ? '' : 'invisible'
                        ].join(' ')}
                        style={menuStyle}
                    >
                        <div className='flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-1.5'>
                            <span className='text-ui text-fg min-w-0 truncate font-medium'>
                                {entry.label}
                            </span>
                            <VersionPicker
                                current={entry.version}
                                unknownLabel={t(
                                    'web.agentRuntimesList.versionUnknown'
                                )}
                                groups={[
                                    { label: null, versions: entry.versions }
                                ]}
                                latest={entry.latest}
                                update={entry.update}
                                kind='framework'
                                busy={busy}
                                busyLabel={t('web.agentNew.frameworkUpgrading')}
                                onPick={
                                    entry.changeable
                                        ? (version) =>
                                              onAction('upgrade', version)
                                        : null
                                }
                            />
                        </div>
                        {entry.agents.length > 0 && (
                            <>
                                <div className='popover-separator' />
                                {entry.agents.map((agent) => (
                                    <Link
                                        key={agent.id}
                                        to={`/agents/${agent.id}/chat`}
                                        role='menuitem'
                                        className='text-ui text-fg hover:bg-soft flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 transition-colors'
                                    >
                                        <span
                                            aria-hidden='true'
                                            className={[
                                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                                DOT_TONE[
                                                    statusTone(agent.status)
                                                ]
                                            ].join(' ')}
                                        />
                                        <span className='min-w-0 flex-1 truncate'>
                                            {agent.name}
                                        </span>
                                        <span
                                            aria-hidden='true'
                                            className='text-subtle shrink-0'
                                        >
                                            →
                                        </span>
                                    </Link>
                                ))}
                            </>
                        )}
                        {error && (
                            <div className='text-caption text-workflow-ship px-2.5 pb-1.5 pt-1'>
                                {error}
                            </div>
                        )}
                    </div>,
                    document.body
                )}
        </div>
    )
}

// The sandbox card's second line: the frameworks on the sandbox, as icons,
// each opening its own version / agents menu. The ones it does not have yet
// are installed from the card's "…" menu; one shows here only while that
// install runs, or to say why it failed.
export const HostFrameworkIcons: FC<{
    entries: HostFrameworkEntry[]
    busyFramework: string | null
    error: { framework: string; message: string } | null
    onAction: (
        framework: AgentFramework,
        action: HostFrameworkAction,
        version?: string
    ) => void
}> = ({ entries, busyFramework, error, onAction }): ReactNode => (
    <span className='flex flex-wrap items-center gap-1.5'>
        {entries
            .filter(
                (entry) =>
                    entry.present ||
                    busyFramework === entry.framework ||
                    error?.framework === entry.framework
            )
            .map((entry) => (
                <HostFrameworkMenu
                    key={entry.framework}
                    entry={entry}
                    busy={busyFramework === entry.framework}
                    error={
                        error?.framework === entry.framework
                            ? error.message
                            : null
                    }
                    onAction={(action, version) =>
                        onAction(entry.framework, action, version)
                    }
                />
            ))}
    </span>
)
