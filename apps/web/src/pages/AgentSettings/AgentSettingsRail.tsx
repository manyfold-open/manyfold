import type { FC, ReactNode } from 'react'
import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import AreaBackLink from '@/components/AreaBackLink'
import SidebarResizeHandle from '@/components/SidebarResizeHandle'
import type { AgentSettingsSectionId } from '@/lib/agentSettingsSections'
import { sectionsFor } from '@/lib/agentSettingsSections'
import { readLastChatLocationRecord } from '@/lib/chatNavigation'
import { useI18n } from '@/lib/i18n'
import { navigateWithRailTransition } from '@/lib/railTransition'
import { useSidebarResize } from '@/lib/useSidebarResize'

// The agent settings rail is the same full-height rail Settings and Customize
// use — same width key, same fill — so crossing between a conversation and its
// settings only moves the rail's *contents*. Anything shorter (a horizontal
// header above a stubby sidebar) would break the View Transitions premise in
// `lib/railTransition` and make the rail's edge jump on every entry.
const AgentSettingsRail: FC<{
    agent: SdkAgent
    activeSection: AgentSettingsSectionId
    onSelectSection: (section: AgentSettingsSectionId) => void
    drawerOpen: boolean
    onDrawerOpenChange: (open: boolean) => void
}> = ({
    agent,
    activeSection,
    onSelectSection,
    drawerOpen,
    onDrawerOpenChange
}): ReactNode => {
    const { direction, t } = useI18n()
    const navigate = useNavigate()
    const sidebarResize = useSidebarResize({
        storageKey: 'nca.web.sidebar.width',
        direction
    })

    const handleBack = useCallback((): void => {
        // The stored chat location is one global slot, overwritten by whichever
        // conversation was visited last — so it can name a *different* agent
        // than the one being configured (chat with A, open B's settings from the
        // agents list). Follow it only when it belongs to this agent.
        const lastChat = readLastChatLocationRecord()
        navigateWithRailTransition(
            navigate,
            lastChat?.agentId === agent.id
                ? lastChat.path
                : `/agents/${agent.id}/chat`,
            'back',
            { replace: true }
        )
    }, [agent.id, navigate])

    const closeDrawer = useCallback((): void => {
        onDrawerOpenChange(false)
    }, [onDrawerOpenChange])

    useEffect(() => {
        closeDrawer()
    }, [activeSection, closeDrawer])

    useEffect(() => {
        if (!drawerOpen) return
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onDrawerOpenChange(false)
        }
        document.addEventListener('keydown', onKey)
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.removeEventListener('keydown', onKey)
            document.body.style.overflow = previousOverflow
        }
    }, [drawerOpen, onDrawerOpenChange])

    const navButton = (
        id: AgentSettingsSectionId,
        labelKey: string
    ): ReactNode => (
        <button
            key={id}
            type='button'
            onClick={() => {
                closeDrawer()
                onSelectSection(id)
            }}
            aria-current={id === activeSection ? 'page' : undefined}
            className={
                id === activeSection
                    ? 'settings-nav-item settings-nav-item-active w-full text-left'
                    : 'settings-nav-item settings-nav-item-idle w-full text-left'
            }
        >
            {t(labelKey)}
        </button>
    )

    const sidebarBody = (
        <div className='settings-sidebar-inner rail-vt-pane'>
            <AreaBackLink
                onBack={handleBack}
                target='chat'
                agentName={agent.name}
            />

            <nav className='settings-nav-list'>
                {sectionsFor(agent).map((section) =>
                    navButton(section.id, section.labelKey)
                )}
            </nav>
        </div>
    )

    return (
        <>
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
                    direction === 'rtl' ? 'right-0 border-l' : 'left-0 border-r',
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

        </>
    )
}

export default AgentSettingsRail
