import type { FC, ReactNode } from 'react'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
    AccountIcon,
    BillingIcon,
    ChannelIcon,
    CodeIcon,
    GeneralIcon,
    type LucideIcon,
    MenuIcon,
    ProviderIcon,
    RuntimeIcon,
    UsageIcon
} from '@/components/icons'
import { readLastChatLocationRecord } from '@/lib/chatNavigation'
import { useI18n } from '@/lib/i18n'
import { navigateWithRailTransition } from '@/lib/railTransition'
import { GhostPageContent } from '@/components/Loading'
import AreaBackLink from '@/components/AreaBackLink'
import SidebarResizeHandle from '@/components/SidebarResizeHandle'
import { useSidebarResize } from '@/lib/useSidebarResize'

const iconClass = 'h-4 w-4 shrink-0'

interface SettingsNavItem {
    labelKey: string
    to: string
    icon: LucideIcon
}

// Ordered personal → workspace resources → developer → billing, so identity
// pages sit together at the top instead of splitting the resource group.
const SETTINGS_ITEMS: SettingsNavItem[] = [
    {
        labelKey: 'web.settingsLayout.general',
        to: '/settings/general',
        icon: GeneralIcon
    },
    {
        labelKey: 'web.settingsLayout.account',
        to: '/settings/account',
        icon: AccountIcon
    },
    {
        labelKey: 'web.settingsLayout.runtimes',
        to: '/settings/runtimes',
        icon: RuntimeIcon
    },
    {
        labelKey: 'web.settingsLayout.providers',
        to: '/settings/model-providers',
        icon: ProviderIcon
    },
    {
        labelKey: 'web.settingsLayout.channels',
        to: '/settings/channels',
        icon: ChannelIcon
    },
    {
        labelKey: 'web.settingsLayout.apiTokens',
        to: '/settings/api-tokens',
        icon: CodeIcon
    },
    {
        labelKey: 'web.settingsLayout.usage',
        to: '/settings/usage',
        icon: UsageIcon
    },
    {
        labelKey: 'web.settingsLayout.planAndBilling',
        to: '/settings/plan-and-billing',
        icon: BillingIcon
    }
]

const navItemClass = ({ isActive }: { isActive: boolean }): string =>
    [
        'settings-nav-item',
        isActive ? 'settings-nav-item-active' : 'settings-nav-item-idle'
    ].join(' ')

const SettingsLayout: FC = (): ReactNode => {
    const navigate = useNavigate()
    const { direction, t } = useI18n()
    const { pathname } = useLocation()
    const [drawerOpen, setDrawerOpen] = useState(false)
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

    const isCascade =
        (pathname.startsWith('/settings/runtimes') &&
            !pathname.startsWith('/settings/runtimes/sandbox')) ||
        pathname.startsWith('/settings/channels') ||
        pathname === '/settings/model-providers'

    const activeItem = SETTINGS_ITEMS.find((item) =>
        pathname.startsWith(item.to)
    )
    const currentLabel = activeItem
        ? t(activeItem.labelKey)
        : t('web.settingsLayout.kicker')

    const sidebarBody = (
        <div className='settings-sidebar-inner rail-vt-pane'>
            <AreaBackLink
                onBack={handleBack}
                target={lastChatPath ? 'chat' : 'workspace'}
                agentName={lastChatAgentName}
            />

            <nav className='settings-nav-list'>
                {SETTINGS_ITEMS.map((item) => {
                    const Icon = item.icon
                    return (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            onClick={closeDrawer}
                            className={navItemClass}
                        >
                            <Icon className={iconClass} />
                            {t(item.labelKey)}
                        </NavLink>
                    )
                })}
            </nav>

            <div className='shadow-ring-light bg-surface mt-auto rounded-md px-3.5 py-3.5'>
                <div className='workbench-kicker'>
                    {t('web.settingsLayout.kicker')}
                </div>
                <p className='text-ui text-muted mt-2'>
                    {t('web.settingsLayout.body')}
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

            {isCascade ? (
                <div className='flex min-w-0 flex-1 flex-col bg-[rgb(var(--color-settings-bg))] lg:h-screen lg:overflow-hidden'>
                    <div className='px-5 pt-6 md:px-6 lg:hidden'>
                        {mobileHeader}
                    </div>
                    <div className='min-h-0 flex-1'>
                        <Suspense fallback={<GhostPageContent />}>
                            <Outlet />
                        </Suspense>
                    </div>
                </div>
            ) : (
                <div className='settings-content'>
                    <div className='settings-page'>{mobileHeader}</div>
                    <Suspense fallback={<GhostPageContent />}>
                        <Outlet />
                    </Suspense>
                </div>
            )}
        </div>
    )
}

export default SettingsLayout
