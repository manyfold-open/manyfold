import type { AgentFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Spinner } from '@/components/Loading'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { statusTone, type TagTone } from '@/components/Tag'
import { useAnchoredMenuPosition } from '@/hooks/useAnchoredMenuPosition'
import { frameworkOnHostState } from '@/lib/agentCreate/frameworkInstall'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

// One framework a sandbox can hold: whether it is there, at which version,
// against the catalog, and who already runs it. The coding CLIs the sprite
// image ships install and upgrade in place; a service framework (OpenClaw,
// Hermes, NarraNexus) is installed and started as an agent-less runtime, and
// upgraded through its first agent.
export interface HostFrameworkEntry {
    framework: AgentFramework
    label: string
    present: boolean
    version: string | null
    latest: string | null
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

const iconClass = (installed: boolean, open: boolean): string =>
    [
        'focus-visible:shadow-focus relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-[color,background-color,box-shadow,border-color] focus:outline-none',
        installed
            ? 'border-success/60 bg-surface hover:bg-surface-hover'
            : 'border-divider text-muted border-dashed opacity-60 hover:opacity-100',
        open ? 'bg-surface-hover' : ''
    ].join(' ')

// The menu behind one icon: the framework, its version against the catalog,
// and the one action that changes it. Portalled and anchored like
// OverflowMenu so a card's rounded overflow cannot clip it.
const HostFrameworkMenu: FC<{
    entry: HostFrameworkEntry
    busy: boolean
    error: string | null
    onAction: (action: HostFrameworkAction) => void
}> = ({ entry, busy, error, onAction }): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const rootRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const menuStyle = useAnchoredMenuPosition(open, rootRef, menuRef, {
        align: 'start',
        matchAnchorWidth: false
    })
    useEffect(() => {
        if (!open) return
        const onDocClick = (e: MouseEvent): void => {
            const target = e.target as Node
            if (
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

    const state = frameworkOnHostState(
        entry.present ? (entry.version ?? '') : null,
        entry.latest
    )
    const action: HostFrameworkAction | null = !entry.present
        ? entry.installable
            ? entry.probed
                ? 'install'
                : 'check'
            : null
        : state.kind === 'outdated'
          ? 'upgrade'
          : null
    const actionLabel =
        action === 'check'
            ? busy
                ? t('web.agentNew.frameworkChecking')
                : t('web.agentNew.checkFramework')
            : action === 'install'
              ? busy
                  ? t('web.agentNew.frameworkInstalling')
                  : t('web.agentNew.installFramework')
              : action === 'upgrade' && state.kind === 'outdated'
                ? busy
                    ? t('web.agentNew.frameworkUpgrading')
                    : t('web.agentNew.upgradeFrameworkTo', {
                          version: state.latest
                      })
                : null
    const statusLine = !entry.present
        ? entry.installable
            ? entry.probed
                ? t('web.agentNew.frameworkNotInstalled')
                : t('web.agentNew.frameworkNotChecked')
            : entry.blockedBy
              ? t('web.agentNew.frameworkServiceSlotTaken', {
                    framework: entry.blockedBy
                })
              : t('web.agentNew.frameworkNotInstalled')
        : !entry.version
          ? t('web.agentNew.frameworkInstalled')
          : state.kind === 'current'
            ? `v${entry.version} · ${t('web.agentNew.frameworkUpToDate')}`
            : `v${entry.version}`
    return (
        <div ref={rootRef} className='relative shrink-0'>
            {open ? (
                <button
                    type='button'
                    aria-label={entry.label}
                    aria-haspopup='menu'
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                    className={iconClass(entry.present, open)}
                >
                    <FrameworkLogo
                        framework={entry.framework}
                        size={18}
                        className={entry.present ? '' : 'grayscale'}
                    />
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
            ) : (
                <ShortcutTooltip label={entry.label}>
                    <button
                        type='button'
                        aria-label={entry.label}
                        aria-haspopup='menu'
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        className={iconClass(entry.present, open)}
                    >
                        <FrameworkLogo
                            framework={entry.framework}
                            size={18}
                            className={entry.present ? '' : 'grayscale'}
                        />
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
                </ShortcutTooltip>
            )}
            {open &&
                createPortal(
                    <div
                        ref={menuRef}
                        role='menu'
                        aria-label={entry.label}
                        className={[
                            'popover-panel bg-surface-elevated shadow-elevated fixed z-[110] w-56 overflow-auto rounded-md p-1',
                            menuStyle ? '' : 'invisible'
                        ].join(' ')}
                        style={menuStyle}
                    >
                        <div className='px-2.5 pb-1 pt-1.5'>
                            <div className='text-ui text-fg font-medium'>
                                {entry.label}
                            </div>
                            <div className='text-caption text-muted mt-0.5 font-mono'>
                                {statusLine}
                            </div>
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
                        {action && actionLabel && (
                            <>
                                <div className='popover-separator' />
                                <button
                                    type='button'
                                    role='menuitem'
                                    disabled={busy}
                                    onClick={() => onAction(action)}
                                    className='text-ui text-link hover:bg-soft disabled:text-muted flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left font-medium transition-colors disabled:cursor-not-allowed'
                                >
                                    {busy && <Spinner size={12} />}
                                    {actionLabel}
                                </button>
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

// The sandbox card's second line: every framework a sandbox can hold, as
// icons — present ones in colour with a green edge, absent ones greyed behind
// a dashed edge — each opening its own version / agents / action menu.
export const HostFrameworkIcons: FC<{
    entries: HostFrameworkEntry[]
    busyFramework: string | null
    error: { framework: string; message: string } | null
    onAction: (framework: AgentFramework, action: HostFrameworkAction) => void
}> = ({ entries, busyFramework, error, onAction }): ReactNode => (
    <span className='flex flex-wrap items-center gap-1.5'>
        {entries.map((entry) => (
            <HostFrameworkMenu
                key={entry.framework}
                entry={entry}
                busy={busyFramework === entry.framework}
                error={
                    error?.framework === entry.framework ? error.message : null
                }
                onAction={(action) => onAction(entry.framework, action)}
            />
        ))}
    </span>
)
