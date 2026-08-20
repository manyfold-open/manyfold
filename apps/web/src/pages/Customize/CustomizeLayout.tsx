import type { FC, ReactNode } from 'react'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
    FolderIcon,
    type LucideIcon,
    McpIcon,
    MenuIcon,
    PlugIcon,
    SkillsIcon
} from '@/components/icons'
import { readLastChatLocationRecord } from '@/lib/chatNavigation'
import { useI18n } from '@/lib/i18n'
import { navigateWithRailTransition } from '@/lib/railTransition'
import AreaBackLink from '@/components/AreaBackLink'
import { GhostPageContent } from '@/components/Loading'
import SidebarResizeHandle from '@/components/SidebarResizeHandle'
import { useSidebarResize } from '@/lib/useSidebarResize'

const iconClass = 'h-4 w-4 shrink-0'

interface CustomizeNavItem {
    labelKey: string
    to: string
    icon: LucideIcon
    // Skills, MCP and Connections each own a family of routes, and "Skill
    // repositories" is carved out of the /skills space — so highlight is
    // decided by an explicit predicate rather than NavLink's exact match.
    isActive: (pathname: string) => boolean
}

const CUSTOMIZE_ITEMS: CustomizeNavItem[] = [
    {
        labelKey: 'web.customize.navSkills',
        to: '/skills/library',
        icon: SkillsIcon,
        isActive: (path) =>
            path.startsWith('/skills') && !path.startsWith('/skills/repos')
    },
    {
        labelKey: 'web.customize.navMcp',
        to: '/mcp/library',
        icon: McpIcon,
        isActive: (path) => path.startsWith('/mcp')
    },
    {
        labelKey: 'web.customize.navConnections',
        to: '/connections',
        icon: PlugIcon,
        isActive: (path) => path.startsWith('/connections')
    },
    {
        labelKey: 'web.skills.reposTab',
        to: '/skills/repos',
        icon: FolderIcon,
        isActive: (path) => path.startsWith('/skills/repos')
    }
]

const CustomizeLayout: FC = (): ReactNode => {
    const navigate = useNavigate()
    const { direction, t } = useI18n()
    const { pathname } = useLocation()
    const [drawerOpen, setDrawerOpen] = useState(false)
    // Share the one secondary-sidebar width with the rail and Settings so the
    // pane keeps its exact width across the enter/exit view transition (no size
    // interpolation) and never jumps between surfaces.
    const sidebarResize = useSidebarResize({
        storageKey: 'nca.web.sidebar.width',
        direction
    })
    // Read once per render so the label and the destination can never disagree.
    const lastChat = readLastChatLocationRecord()
    const lastChatPath = lastChat?.path ?? null
    const lastChatAgentName = lastChat?.agentName ?? null
    const handleBack = useCallback((): void => {
        navigateWithRailTransition(
            navigate,
            lastChatPath ?? '/workspace',
            'back',
            { replace: true }
        )
    }, [lastChatPath, navigate])
    const closeDrawer = useCallback((): void => {
        setDrawerOpen(false)
    }, [])

    useEffect(() => {
        setDrawerOpen(false)
    }, [pathname])

    useEffect(() => {
        if (!drawerOpen) return
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setDrawerOpen(false)
        }
        document.addEventListener('keydown', onKey)
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.removeEventListener('keydown', onKey)
            document.body.style.overflow = previousOverflow
        }
    }, [drawerOpen])

    const activeItem = CUSTOMIZE_ITEMS.find((item) => item.isActive(pathname))
    const currentLabel = activeItem
        ? t(activeItem.labelKey)
        : t('web.shell.customize')

    const sidebarBody = (
        <div className='settings-sidebar-inner rail-vt-pane'>
            <AreaBackLink
                onBack={handleBack}
                target={lastChatPath ? 'chat' : 'workspace'}
                agentName={lastChatAgentName}
            />

            <nav className='settings-nav-list'>
                {CUSTOMIZE_ITEMS.map((item) => {
                    const Icon = item.icon
                    return (
                        <Link
                            key={item.to}
                            to={item.to}
                            onClick={closeDrawer}
                            className={[
                                'settings-nav-item',
                                item.isActive(pathname)
                                    ? 'settings-nav-item-active'
                                    : 'settings-nav-item-idle'
                            ].join(' ')}
                        >
                            <Icon className={iconClass} />
                            {t(item.labelKey)}
                        </Link>
                    )
                })}
            </nav>

            <div className='shadow-ring-light bg-surface mt-auto rounded-md px-3.5 py-3.5'>
                <div className='workbench-kicker'>
                    {t('web.shell.customize')}
                </div>
                <p className='text-ui text-muted mt-2'>
                    {t('web.customize.layoutBody')}
                </p>
            </div>
        </div>
    )

    const mobileHeader = (
        <header className='settings-mobile-header lg:hidden'>
            <button
                type='button'
                onClick={() => setDrawerOpen(true)}
                aria-label={t('web.shell.menu')}
                className='settings-mobile-menu-btn'
            >
                <MenuIcon className={iconClass} />
            </button>
            <span className='text-ui text-fg min-w-0 truncate font-medium'>
                {currentLabel}
            </span>
        </header>
    )

    return (
        <div className='settings-shell'>
            {drawerOpen && (
                <button
                    type='button'
                    aria-label={t('web.shell.closeSidebar')}
                    onClick={closeDrawer}
                    className='settings-drawer-backdrop lg:hidden'
                />
            )}

            <aside
                className={[
                    'settings-drawer lg:hidden',
                    direction === 'rtl'
                        ? 'right-0 border-l'
                        : 'left-0 border-r',
                    drawerOpen
                        ? 'translate-x-0'
                        : direction === 'rtl'
                          ? 'translate-x-full'
                          : '-translate-x-full'
                ].join(' ')}
            >
                {sidebarBody}
            </aside>

            <aside
                ref={sidebarResize.asideRef}
                style={{ width: sidebarResize.width }}
                className={[
                    'settings-sidebar relative',
                    sidebarResize.resizing
                        ? ''
                        : 'transition-[width] duration-200',
                    direction === 'rtl' ? 'border-l' : 'border-r'
                ].join(' ')}
            >
                {sidebarBody}
                <SidebarResizeHandle
                    direction={direction}
                    resizing={sidebarResize.resizing}
                    label={t('web.shell.resizeSidebar')}
                    onPointerDown={sidebarResize.startResize}
                    onReset={sidebarResize.resetWidth}
                />
            </aside>

            <div className='settings-content'>
                <div className='mx-auto w-full max-w-6xl'>
                    {mobileHeader}
                    <Suspense fallback={<GhostPageContent />}>
                        <Outlet />
                    </Suspense>
                </div>
            </div>
        </div>
    )
}

export default CustomizeLayout
