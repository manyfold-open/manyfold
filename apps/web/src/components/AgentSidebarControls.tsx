import type { FC, ReactNode } from 'react'
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import { createPortal } from 'react-dom'
import type { SdkAgent } from '@manyfold/sdk'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useI18n } from '@/lib/i18n'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { CheckIcon, ChevronRightIcon, FilterIcon } from '@/components/icons'
import {
    activeFilterCount,
    agentGroupKeys,
    agentSortKeys,
    availableFrameworkOptions,
    availableHostOptions,
    lastActivityWindows,
    type AgentGroupKey,
    type AgentSortKey,
    type AgentsViewConfig,
    type LastActivityWindow
} from '@/lib/agentSidebarView'

const PANEL_WIDTH = 264
const SUBMENU_WIDTH = 224

type SectionKey = 'host' | 'framework' | 'activity' | 'group' | 'sort'

interface Props {
    agents: SdkAgent[]
    config: AgentsViewConfig
    hostNames: ReadonlyMap<string, string>
    onChange: (config: AgentsViewConfig) => void
}

const AgentSidebarControls: FC<Props> = ({
    agents,
    config,
    hostNames,
    onChange
}) => {
    const { t } = useI18n()
    const [open, setOpen] = useState(false)
    const [expanded, setExpanded] = useState<SectionKey | null>(null)
    const btnRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const submenuRef = useRef<HTMLDivElement>(null)
    const rowRefs = useRef<Partial<Record<SectionKey, HTMLButtonElement | null>>>(
        {}
    )
    const [pos, setPos] = useState<{ left: number; top: number }>({
        left: 0,
        top: 0
    })
    const [subPos, setSubPos] = useState<{
        left: number
        top: number
        maxHeight: number
    } | null>(null)

    const updatePos = useCallback((): void => {
        const rect = btnRef.current?.getBoundingClientRect()
        if (typeof window === 'undefined' || !rect) return
        const right = Math.min(rect.right, window.innerWidth - 8)
        const left = Math.max(8, right - PANEL_WIDTH)
        setPos({ left, top: rect.bottom + 6 })
    }, [])

    const updateSubPos = useCallback((): void => {
        const section = expanded
        const row = section ? rowRefs.current[section] : null
        const panel = panelRef.current
        if (typeof window === 'undefined' || !row || !panel) return
        const r = row.getBoundingClientRect()
        const p = panel.getBoundingClientRect()
        const gap = 4
        let left = p.right + gap
        if (left + SUBMENU_WIDTH > window.innerWidth - 8)
            left = p.left - SUBMENU_WIDTH - gap
        left = Math.max(8, left)
        const top = Math.max(8, r.top)
        const maxHeight = Math.max(120, window.innerHeight - top - 12)
        setSubPos({ left, top, maxHeight })
    }, [expanded])

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

    useLayoutEffect(() => {
        if (!open || !expanded) {
            setSubPos(null)
            return
        }
        updateSubPos()
        const handle = (): void => updateSubPos()
        window.addEventListener('resize', handle)
        window.addEventListener('scroll', handle, true)
        return () => {
            window.removeEventListener('resize', handle)
            window.removeEventListener('scroll', handle, true)
        }
    }, [open, expanded, updateSubPos])

    useEffect(() => {
        if (!open) setExpanded(null)
    }, [open])

    useEffect(() => {
        if (!open) return
        const onDown = (event: MouseEvent): void => {
            const target = event.target as Node
            if (
                !panelRef.current?.contains(target) &&
                !btnRef.current?.contains(target) &&
                !submenuRef.current?.contains(target)
            )
                setOpen(false)
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            if (expanded) setExpanded(null)
            else setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open, expanded])

    const hostOptions = useMemo(
        () => availableHostOptions(agents, hostNames),
        [agents, hostNames]
    )
    const frameworkOptions = useMemo(
        () => availableFrameworkOptions(agents),
        [agents]
    )

    const activeCount = activeFilterCount(config)
    const hasFilters = activeCount > 0

    const toggleSection = (section: SectionKey): void =>
        setExpanded((prev) => (prev === section ? null : section))

    const toggleInArray = <T,>(list: T[], value: T): T[] =>
        list.includes(value)
            ? list.filter((item) => item !== value)
            : [...list, value]

    const groupLabel = (key: AgentGroupKey): string => {
        switch (key) {
            case 'host':
                return t('web.shell.agentsView.runtimeHost')
            case 'framework':
                return t('web.shell.agentsView.framework')
            case 'date':
                return t('web.shell.agentsView.groupDate')
            default:
                return t('web.shell.agentsView.groupNone')
        }
    }

    const sortLabel = (key: AgentSortKey): string =>
        key === 'recency'
            ? t('web.shell.agentsView.sortRecency')
            : t('web.shell.agentsView.sortCreated')

    const activityLabel = (window: LastActivityWindow): string => {
        switch (window) {
            case '1d':
                return t('web.shell.agentsView.activity1d')
            case '3d':
                return t('web.shell.agentsView.activity3d')
            case '7d':
                return t('web.shell.agentsView.activity7d')
            case '30d':
                return t('web.shell.agentsView.activity30d')
            default:
                return t('web.shell.agentsView.activityAll')
        }
    }

    const activityValue = (window: LastActivityWindow): string =>
        window === 'all' ? t('web.shell.agentsView.all') : window

    const filterValue = (count: number): string =>
        count === 0
            ? t('web.shell.agentsView.all')
            : t('web.shell.agentsView.selectedCount', { count })

    const branch = (
        section: SectionKey,
        label: string,
        value: string,
        active: boolean
    ): ReactNode => {
        const isOpen = expanded === section
        return (
            <button
                key={`branch-${section}`}
                type='button'
                ref={(el) => {
                    rowRefs.current[section] = el
                }}
                onClick={() => toggleSection(section)}
                aria-haspopup='menu'
                aria-expanded={isOpen}
                className={`hover:bg-soft flex w-full items-center justify-between gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors ${isOpen ? 'bg-soft' : ''}`}
            >
                <span className='text-ui text-fg shrink-0 font-medium'>
                    {label}
                </span>
                <span className='flex min-w-0 items-center gap-1'>
                    <span
                        className={`text-caption truncate ${active ? 'text-link' : 'text-muted'}`}
                    >
                        {value}
                    </span>
                    <ChevronRightIcon className='text-subtle h-3.5 w-3.5 shrink-0' />
                </span>
            </button>
        )
    }

    const option = (
        key: string,
        label: string,
        selected: boolean,
        multi: boolean,
        onClick: () => void,
        count?: number
    ): ReactNode => (
        <button
            key={`opt-${key}`}
            type='button'
            role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
            aria-checked={selected}
            onClick={onClick}
            className='hover:bg-soft flex w-full items-center justify-between gap-2.5 rounded-sm px-2.5 py-1.5 text-left transition-colors'
        >
            <span
                className={
                    selected
                        ? 'text-ui text-fg min-w-0 truncate font-medium'
                        : 'text-ui text-fg min-w-0 truncate'
                }
            >
                {label}
            </span>
            <span className='flex shrink-0 items-center gap-1.5'>
                {typeof count === 'number' && (
                    <span className='text-caption text-subtle tabular-nums'>
                        {count}
                    </span>
                )}
                <CheckIcon
                    className={`text-link h-4 w-4 ${selected ? '' : 'invisible'}`}
                />
            </span>
        </button>
    )

    const submenuOptions = (section: SectionKey): ReactNode => {
        switch (section) {
            case 'host':
                return hostOptions.map((host) =>
                    option(
                        host.key,
                        host.label,
                        config.hosts.includes(host.key),
                        true,
                        () =>
                            onChange({
                                ...config,
                                hosts: toggleInArray(config.hosts, host.key)
                            }),
                        host.count
                    )
                )
            case 'framework':
                return frameworkOptions.map((item) =>
                    option(
                        item.framework,
                        frameworkLabel(item.framework),
                        config.frameworks.includes(item.framework),
                        true,
                        () =>
                            onChange({
                                ...config,
                                frameworks: toggleInArray(
                                    config.frameworks,
                                    item.framework
                                )
                            }),
                        item.count
                    )
                )
            case 'activity':
                return lastActivityWindows.map((window) =>
                    option(
                        window,
                        activityLabel(window),
                        config.activity === window,
                        false,
                        () => {
                            onChange({ ...config, activity: window })
                            setExpanded(null)
                        }
                    )
                )
            case 'group':
                return agentGroupKeys.map((key) =>
                    option(
                        `group-${key}`,
                        groupLabel(key),
                        config.groupBy === key,
                        false,
                        () => {
                            onChange({ ...config, groupBy: key })
                            setExpanded(null)
                        }
                    )
                )
            default:
                return agentSortKeys.map((key) =>
                    option(
                        `sort-${key}`,
                        sortLabel(key),
                        config.sortBy === key,
                        false,
                        () => {
                            onChange({ ...config, sortBy: key })
                            setExpanded(null)
                        }
                    )
                )
        }
    }

    const panel = open
        ? createPortal(
              <div
                  ref={panelRef}
                  role='dialog'
                  aria-label={t('web.shell.agentsView.button')}
                  className='popover-panel bg-surface-elevated shadow-elevated fixed z-[200] rounded-md p-1'
                  style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH }}
              >
                  {branch(
                      'host',
                      t('web.shell.agentsView.runtimeHost'),
                      filterValue(config.hosts.length),
                      config.hosts.length > 0
                  )}
                  {branch(
                      'framework',
                      t('web.shell.agentsView.framework'),
                      filterValue(config.frameworks.length),
                      config.frameworks.length > 0
                  )}
                  {branch(
                      'activity',
                      t('web.shell.agentsView.lastActivity'),
                      activityValue(config.activity),
                      config.activity !== 'all'
                  )}

                  <div className='popover-separator' />

                  {branch(
                      'group',
                      t('web.shell.agentsView.groupBy'),
                      groupLabel(config.groupBy),
                      config.groupBy !== 'none'
                  )}
                  {branch(
                      'sort',
                      t('web.shell.agentsView.sortBy'),
                      sortLabel(config.sortBy),
                      config.sortBy !== 'created'
                  )}

                  <div className='popover-separator' />

                  <button
                      type='button'
                      disabled={!hasFilters}
                      onClick={() =>
                          onChange({
                              ...config,
                              hosts: [],
                              frameworks: [],
                              activity: 'all'
                          })
                      }
                      className='text-ui text-muted hover:bg-soft hover:text-fg flex w-full items-center rounded-sm px-2.5 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent'
                  >
                      {t('web.shell.agentsView.clearFilters')}
                  </button>
              </div>,
              document.body
          )
        : null

    const submenu =
        open && expanded && subPos
            ? createPortal(
                  <div
                      ref={submenuRef}
                      role='menu'
                      className='popover-panel bg-surface-elevated shadow-elevated fixed z-[201] overflow-y-auto rounded-md p-1'
                      style={{
                          left: subPos.left,
                          top: subPos.top,
                          width: SUBMENU_WIDTH,
                          maxHeight: subPos.maxHeight
                      }}
                  >
                      {submenuOptions(expanded)}
                  </div>,
                  document.body
              )
            : null

    return (
        <>
            <ShortcutTooltip label={t('web.shell.agentsView.button')}>
                <button
                    ref={btnRef}
                    type='button'
                    onClick={() => setOpen((value) => !value)}
                    aria-label={t('web.shell.agentsView.button')}
                    aria-haspopup='dialog'
                    aria-expanded={open}
                    className={`relative inline-flex h-9 w-9 items-center justify-center rounded-pill transition-colors ${
                        open || hasFilters
                            ? 'text-fg bg-rail-hover'
                            : 'text-subtle hover:text-fg hover:bg-rail-hover'
                    }`}
                >
                    <FilterIcon className='h-[18px] w-[18px] shrink-0' />
                    {hasFilters && (
                        <span className='bg-info-bg text-info absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-pill px-1 text-caption font-medium tabular-nums'>
                            {activeCount}
                        </span>
                    )}
                </button>
            </ShortcutTooltip>
            {panel}
            {submenu}
        </>
    )
}

export default AgentSidebarControls
