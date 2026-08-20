import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { t } from '@manyfold/i18n'
import {
    Bot,
    ChevronDown,
    LayoutDashboard,
    Library,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    ServerCog,
    SlidersHorizontal,
    Users,
    X,
    type LucideIcon
} from 'lucide-react'
import { AuthUserButton } from '@/lib/auth'
import { adminRoutes } from '@/routes'
import { rolloutsHomeRoute } from '@/rollouts-home'
import { extraNavGroupItems, extraNavGroups } from '@/nav-extra'
import { cn } from '@/ui/classNames'

const sidebarStorageKey = 'nca.admin.sidebar.collapsed'

const initialSidebarCollapsed = (): boolean => {
    if (typeof window === 'undefined') return false

    try {
        const stored = window.localStorage.getItem(sidebarStorageKey)
        if (stored !== null) return stored === 'true'
    } catch {
        return false
    }

    return window.matchMedia?.('(max-width: 900px)').matches ?? false
}

export interface NavItem {
    to: string
    labelKey: string
    end?: boolean
    aliases?: string[]
}

export interface NavGroup {
    id: string
    labelKey: string
    icon: LucideIcon
    items: NavItem[]
}

const dashboardItem: NavItem = {
    to: adminRoutes.dashboard,
    labelKey: 'admin.nav.dashboard',
    end: true
}

const coreNavGroups: NavGroup[] = [
    {
        id: 'operations',
        labelKey: 'admin.nav.operations',
        icon: Bot,
        items: [
            {
                to: adminRoutes.agents,
                labelKey: 'admin.nav.agentManagement',
                aliases: [adminRoutes.runtimes, adminRoutes.chatSessions]
            },
            { to: adminRoutes.sandboxes, labelKey: 'admin.nav.sandboxes' },
            { to: adminRoutes.channels, labelKey: 'admin.nav.channels' },
            {
                to: adminRoutes.modelProviderKeys,
                labelKey: 'admin.nav.modelProviders',
                aliases: [
                    adminRoutes.modelProviderChannels,
                    adminRoutes.modelProviderModels
                ]
            }
        ]
    },
    {
        id: 'infrastructure',
        labelKey: 'admin.nav.infrastructure',
        icon: ServerCog,
        items: [
            { to: adminRoutes.clusters, labelKey: 'admin.nav.clusters' },
            {
                to: adminRoutes.sandboxAccounts,
                labelKey: 'admin.nav.spritesAccounts'
            },
            {
                to: adminRoutes.selfOwnedComputerMachines,
                labelKey: 'admin.nav.selfOwnedComputers',
                aliases: [adminRoutes.selfOwnedComputerClientPolicy]
            },
            {
                to: adminRoutes.sandboxCapacity,
                labelKey: 'admin.nav.sandboxCapacity'
            }
        ]
    },
    {
        id: 'users-billing',
        labelKey: 'admin.nav.usersBilling',
        icon: Users,
        items: [
            {
                to: adminRoutes.accountUsers,
                labelKey: 'admin.nav.accounts'
            }
        ]
    },
    {
        id: 'catalogs',
        labelKey: 'admin.nav.catalogs',
        icon: Library,
        items: [
            {
                to: adminRoutes.frameworkModels,
                labelKey: 'admin.nav.frameworks',
                aliases: [
                    adminRoutes.frameworkVersions,
                    adminRoutes.frameworkProvisioning
                ]
            },
            {
                to: adminRoutes.skillCatalog,
                labelKey: 'admin.nav.skills',
                aliases: [adminRoutes.skillSources, adminRoutes.skillCategories]
            },
            {
                to: adminRoutes.mcpCatalog,
                labelKey: 'admin.nav.mcp',
                aliases: [adminRoutes.mcpCategories]
            }
        ]
    },
    {
        id: 'platform-settings',
        labelKey: 'admin.nav.platformSettings',
        icon: SlidersHorizontal,
        items: [
            {
                to: adminRoutes.platformAuthentication,
                labelKey: 'admin.nav.loginProvider'
            },
            {
                to: adminRoutes.platformEmail,
                labelKey: 'admin.nav.emailProvider'
            },
            {
                to: adminRoutes.notificationWebhooks,
                labelKey: 'admin.nav.notificationWebhooks'
            },
            {
                to: adminRoutes.turnPolicies,
                labelKey: 'admin.nav.turnPolicies'
            },
            {
                to: adminRoutes.dataRetention,
                labelKey: 'admin.nav.dataRetention'
            },
            {
                to: rolloutsHomeRoute,
                labelKey: 'admin.nav.rollouts',
                aliases: [
                    adminRoutes.rolloutExperiments,
                    adminRoutes.rolloutFeatureFlags
                ]
            }
        ]
    }
]

// Editions composition (§3.4): the overlay's nav-extra module contributes the
// commercial groups and per-group items; the open-source module contributes
// nothing. Extra groups splice in after the group they name so ordering
// matches the pre-split admin.
const navGroups: NavGroup[] = (() => {
    const groups = coreNavGroups.map((group) => ({
        ...group,
        items: [...group.items, ...(extraNavGroupItems[group.id] ?? [])]
    }))
    for (const extra of extraNavGroups) {
        const at = groups.findIndex((g) => g.id === extra.insertAfter)
        groups.splice(at === -1 ? groups.length : at + 1, 0, extra.group)
    }
    return groups
})()

const matchesNavItem = (pathname: string, item: NavItem): boolean =>
    [item.to, ...(item.aliases ?? [])].some(
        (path) =>
            pathname === path || (!item.end && pathname.startsWith(`${path}/`))
    )

const activeNavGroupId = (pathname: string): string | null =>
    navGroups.find((group) =>
        group.items.some((item) => matchesNavItem(pathname, item))
    )?.id ?? null

const navItemClass =
    (collapsed: boolean, mobile: boolean) =>
    ({ isActive }: { isActive: boolean }): string =>
        cn(
            'group flex items-center rounded text-caption font-normal transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
            mobile ? 'h-11' : 'h-8',
            collapsed ? 'justify-center px-0' : 'gap-2 px-2.5',
            isActive
                ? 'bg-brand-subtle text-brand'
                : 'text-heading hover:bg-surface-muted'
        )

const childNavItemClass =
    (mobile: boolean, selected: boolean) =>
    ({ isActive }: { isActive: boolean }): string =>
        cn(
            'flex items-center rounded pr-2.5 pl-9 text-caption font-normal transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
            mobile ? 'h-11' : 'h-8',
            isActive || selected
                ? 'bg-brand-subtle text-brand'
                : 'text-heading hover:bg-surface-muted'
        )

const AppLayout: FC = (): ReactNode => {
    const location = useLocation()
    const currentGroupId = activeNavGroupId(location.pathname)
    const mobileSidebarRef = useRef<HTMLDialogElement>(null)
    const [sidebarCollapsed, setSidebarCollapsed] = useState(
        initialSidebarCollapsed
    )
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
    const [openGroupId, setOpenGroupId] = useState<string | null>(
        currentGroupId
    )

    useEffect(() => {
        if (currentGroupId) setOpenGroupId(currentGroupId)
    }, [currentGroupId])

    useEffect(() => {
        setMobileSidebarOpen(false)
    }, [location.pathname])

    useEffect(() => {
        const dialog = mobileSidebarRef.current
        if (!dialog) return

        if (mobileSidebarOpen && !dialog.open) dialog.showModal()
        if (!mobileSidebarOpen && dialog.open) dialog.close()
    }, [mobileSidebarOpen])

    useEffect(() => {
        if (!mobileSidebarOpen) return

        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            setMobileSidebarOpen(false)
        }

        window.addEventListener('keydown', closeOnEscape)
        return () => window.removeEventListener('keydown', closeOnEscape)
    }, [mobileSidebarOpen])

    useEffect(() => {
        const desktopMedia = window.matchMedia('(min-width: 640px)')
        const closeMobileSidebar = (): void => {
            if (desktopMedia.matches) setMobileSidebarOpen(false)
        }

        desktopMedia.addEventListener('change', closeMobileSidebar)
        return () => {
            desktopMedia.removeEventListener('change', closeMobileSidebar)
        }
    }, [])

    const updateSidebarCollapsed = (next: boolean): void => {
        setSidebarCollapsed(next)
        try {
            window.localStorage.setItem(sidebarStorageKey, String(next))
        } catch {
            // Local storage can be unavailable in privacy-restricted contexts.
        }
    }

    const toggleSidebar = (): void => {
        updateSidebarCollapsed(!sidebarCollapsed)
    }

    const toggleNavGroup = (groupId: string, collapsed: boolean): void => {
        if (collapsed) {
            updateSidebarCollapsed(false)
            setOpenGroupId(groupId)
            return
        }

        setOpenGroupId((current) => (current === groupId ? null : groupId))
    }

    const dashboardLabel = t(dashboardItem.labelKey)
    const sidebarToggleLabel = sidebarCollapsed
        ? t('admin.nav.expandSidebar')
        : t('admin.nav.collapseSidebar')

    const renderSidebarContent = (
        collapsed: boolean,
        mobile: boolean
    ): ReactNode => {
        const sidebarId = mobile ? 'mobile' : 'desktop'
        const topControlLabel = mobile
            ? t('admin.nav.closeSidebar')
            : sidebarToggleLabel

        return (
            <>
                <div
                    className={cn(
                        'flex shrink-0 items-center',
                        mobile ? 'mb-3 h-11' : 'mb-5 h-8',
                        collapsed ? 'justify-center' : 'justify-between gap-2'
                    )}
                >
                    {!collapsed && (
                        <div
                            id={mobile ? 'admin-mobile-nav-title' : undefined}
                            className='text-body-lg text-heading min-w-0 px-1 font-light'
                        >
                            {t('common.appName')}
                        </div>
                    )}
                    <button
                        type='button'
                        aria-label={topControlLabel}
                        title={topControlLabel}
                        onClick={
                            mobile
                                ? () => setMobileSidebarOpen(false)
                                : toggleSidebar
                        }
                        className={cn(
                            'text-body hover:bg-surface-muted hover:text-heading focus-visible:ring-brand inline-flex items-center justify-center rounded border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                            mobile ? 'h-11 w-11' : 'h-7 w-7'
                        )}
                    >
                        {mobile ? (
                            <X size={18} strokeWidth={1.75} />
                        ) : collapsed ? (
                            <PanelLeftOpen size={16} strokeWidth={1.75} />
                        ) : (
                            <PanelLeftClose size={16} strokeWidth={1.75} />
                        )}
                    </button>
                </div>
                <nav
                    aria-label={t('admin.nav.primaryNavigation')}
                    className='flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto'
                >
                    <NavLink
                        to={dashboardItem.to}
                        end={dashboardItem.end}
                        aria-label={dashboardLabel}
                        title={collapsed ? dashboardLabel : undefined}
                        className={navItemClass(collapsed, mobile)}
                    >
                        <LayoutDashboard
                            aria-hidden='true'
                            size={16}
                            strokeWidth={1.75}
                            className='shrink-0'
                        />
                        <span
                            className={cn(
                                'min-w-0 truncate',
                                collapsed && 'sr-only'
                            )}
                        >
                            {dashboardLabel}
                        </span>
                    </NavLink>
                    {navGroups.map((group) => {
                        const label = t(group.labelKey)
                        const expanded = !collapsed && openGroupId === group.id
                        const active = currentGroupId === group.id
                        const Icon = group.icon
                        const panelId = `${sidebarId}-admin-nav-${group.id}`

                        return (
                            <div key={group.id}>
                                <button
                                    type='button'
                                    aria-expanded={expanded}
                                    aria-controls={panelId}
                                    aria-label={
                                        expanded
                                            ? t('admin.nav.collapseGroup', {
                                                  group: label
                                              })
                                            : t('admin.nav.expandGroup', {
                                                  group: label
                                              })
                                    }
                                    title={collapsed ? label : undefined}
                                    onClick={() =>
                                        toggleNavGroup(group.id, collapsed)
                                    }
                                    className={cn(
                                        'text-caption focus-visible:ring-brand group flex w-full items-center rounded font-normal transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                                        mobile ? 'h-11' : 'h-8',
                                        collapsed
                                            ? 'justify-center px-0'
                                            : 'gap-2 px-2.5',
                                        active
                                            ? collapsed
                                                ? 'bg-brand-subtle text-brand'
                                                : 'text-brand'
                                            : 'text-heading hover:bg-surface-muted'
                                    )}
                                >
                                    <Icon
                                        aria-hidden='true'
                                        size={16}
                                        strokeWidth={1.75}
                                        className='shrink-0'
                                    />
                                    <span
                                        className={cn(
                                            'min-w-0 flex-1 truncate text-left',
                                            collapsed && 'sr-only'
                                        )}
                                    >
                                        {label}
                                    </span>
                                    {!collapsed && (
                                        <ChevronDown
                                            aria-hidden='true'
                                            size={14}
                                            strokeWidth={1.75}
                                            className={cn(
                                                'shrink-0 transition-transform',
                                                !expanded && '-rotate-90'
                                            )}
                                        />
                                    )}
                                </button>
                                <div
                                    id={panelId}
                                    className={cn(
                                        'mt-1 flex-col gap-1',
                                        expanded ? 'flex' : 'hidden'
                                    )}
                                >
                                    {group.items.map((item) => {
                                        const itemLabel = t(item.labelKey)
                                        return (
                                            <NavLink
                                                key={item.to}
                                                to={item.to}
                                                end={item.end}
                                                aria-label={itemLabel}
                                                title={itemLabel}
                                                className={childNavItemClass(
                                                    mobile,
                                                    matchesNavItem(
                                                        location.pathname,
                                                        item
                                                    )
                                                )}
                                            >
                                                <span className='min-w-0 truncate'>
                                                    {itemLabel}
                                                </span>
                                            </NavLink>
                                        )
                                    })}
                                </div>
                            </div>
                        )
                    })}
                </nav>
            </>
        )
    }

    return (
        <div className='flex min-h-screen bg-white'>
            <aside
                className={cn(
                    'border-border sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-white py-4 transition-[width] duration-200 ease-out sm:flex',
                    sidebarCollapsed ? 'w-14 px-2' : 'w-52 px-3'
                )}
            >
                {renderSidebarContent(sidebarCollapsed, false)}
            </aside>
            <dialog
                ref={mobileSidebarRef}
                aria-labelledby='admin-mobile-nav-title'
                onCancel={() => setMobileSidebarOpen(false)}
                onClose={() => setMobileSidebarOpen(false)}
                onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect()
                    const inside =
                        event.clientX >= bounds.left &&
                        event.clientX <= bounds.right &&
                        event.clientY >= bounds.top &&
                        event.clientY <= bounds.bottom
                    if (!inside) setMobileSidebarOpen(false)
                }}
                className='border-border fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[calc(100vw-3rem)] max-w-72 overflow-hidden border-0 border-r bg-white p-0 shadow-xl backdrop:bg-black/25 sm:hidden'
            >
                <aside className='flex h-full flex-col px-3 py-4'>
                    {renderSidebarContent(false, true)}
                </aside>
            </dialog>
            <div className='flex min-w-0 flex-1 flex-col'>
                <header className='border-border sticky top-0 z-10 flex h-12 items-center justify-between border-b bg-white/95 px-3 backdrop-blur sm:justify-end sm:px-5'>
                    <button
                        type='button'
                        aria-label={t('admin.nav.openSidebar')}
                        aria-haspopup='dialog'
                        aria-expanded={mobileSidebarOpen}
                        onClick={() => setMobileSidebarOpen(true)}
                        className='text-body hover:bg-surface-muted hover:text-heading focus-visible:ring-brand inline-flex h-10 w-10 items-center justify-center rounded border border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 sm:hidden'
                    >
                        <Menu aria-hidden='true' size={18} strokeWidth={1.75} />
                    </button>
                    <AuthUserButton />
                </header>
                <main className='flex-1 overflow-auto p-4 lg:p-5 xl:p-6'>
                    <Outlet />
                </main>
            </div>
        </div>
    )
}

export default AppLayout