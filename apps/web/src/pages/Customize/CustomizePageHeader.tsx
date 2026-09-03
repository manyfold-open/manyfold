import type { FC, ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useI18n } from '@/lib/i18n'

type Group = 'skills' | 'mcp' | 'connections'

interface ViewTab {
    to: string
    labelKey: string
}

const GROUP_META: Record<Group, { titleKey: string; descKey: string }> = {
    skills: {
        titleKey: 'web.customize.navSkills',
        descKey: 'web.customize.skillsGroupDesc'
    },
    mcp: {
        titleKey: 'web.customize.navMcp',
        descKey: 'web.customize.mcpGroupDesc'
    },
    connections: {
        titleKey: 'web.customize.navConnections',
        descKey: 'web.customize.connectionsGroupDesc'
    }
}

const GROUP_TABS: Record<'skills' | 'mcp', ViewTab[]> = {
    skills: [
        { to: '/skills/library', labelKey: 'web.customize.navMySkills' },
        { to: '/skills', labelKey: 'web.customize.navSkillsCatalog' }
    ],
    mcp: [
        { to: '/mcp/library', labelKey: 'web.customize.navMyMcp' },
        { to: '/mcp', labelKey: 'web.customize.navMcpCatalog' }
    ]
}

const viewTabClass = ({ isActive }: { isActive: boolean }): string =>
    [
        'text-ui -mb-px inline-flex items-center border-b-2 px-0.5 pb-2.5 font-medium transition-colors',
        isActive
            ? 'border-fg text-fg'
            : 'text-muted hover:text-fg border-transparent'
    ].join(' ')

interface CustomizePageHeaderProps {
    // The resource group; drives the static title, one-line description and,
    // for skills/mcp, the My… / …catalog tab bar. Connections has no sub-views,
    // so it renders title + description only.
    group: Group
    // Right side of the title row (e.g. a "New skill" primary button).
    action?: ReactNode
    // Right side of the tab row (e.g. a "Manage skill repositories" link).
    aside?: ReactNode
}

const CustomizePageHeader: FC<CustomizePageHeaderProps> = ({
    group,
    action,
    aside
}): ReactNode => {
    const { t } = useI18n()
    const meta = GROUP_META[group]
    const tabs = group === 'connections' ? null : GROUP_TABS[group]

    return (
        <header className='mb-6'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <h1 className='text-h1 text-fg'>
                        {t(meta.titleKey)}
                    </h1>
                    <p className='text-ui text-muted mt-1'>{t(meta.descKey)}</p>
                </div>
                {action}
            </div>

            {tabs && (
                <div className='border-divider/80 mt-4 flex items-end justify-between gap-3 border-b'>
                    <nav className='flex gap-6'>
                        {tabs.map((tab) => (
                            <NavLink
                                key={tab.to}
                                to={tab.to}
                                end
                                className={viewTabClass}
                            >
                                {t(tab.labelKey)}
                            </NavLink>
                        ))}
                    </nav>
                    {aside && <div className='pb-2.5'>{aside}</div>}
                </div>
            )}
        </header>
    )
}

export default CustomizePageHeader
