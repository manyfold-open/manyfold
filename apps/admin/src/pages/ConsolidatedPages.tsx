import type { FC, ReactNode } from 'react'
import AgentsList from '@/pages/Agents/AgentsList'
import AgentRuntimesList from '@/pages/AgentRuntimes/AgentRuntimesList'
import ChatSessionsList from '@/pages/ChatSessions/ChatSessionsList'
import FrameworkCatalogPage from '@/pages/FrameworkCatalog/FrameworkCatalogPage'
import FrameworkDefaultVersionsSettingsPage from '@/pages/FrameworkDefaultVersionsSettings'
import FrameworkRuntimeDefaultsSettingsPage from '@/pages/FrameworkRuntimeDefaultsSettings'
import SkillsCatalogList from '@/pages/Catalog/SkillsCatalogList'
import SkillReposSettingsPage from '@/pages/SkillReposSettings'
import CatalogCategoriesPage from '@/pages/Catalog/CatalogCategoriesPage'
import McpCatalogList from '@/pages/Catalog/McpCatalogList'
import DaemonsList from '@/pages/Daemons/DaemonsList'
import CliMinimumVersionSettingsPage from '@/pages/CliMinimumVersionSettings'
import ChatExecTimeoutsSettingsPage from '@/pages/ChatExecTimeoutsSettings'
import A2aTurnTimeoutsSettingsPage from '@/pages/A2aTurnTimeoutsSettings'
import AutomationRetentionSettingsPage from '@/pages/AutomationRetentionSettings'
import { adminRoutes } from '@/routes'
import { TabbedPage } from '@/pages/consolidated/TabbedPage'
import { Heading } from '@/ui'

export const AgentManagementPage: FC<{
    view: 'agents' | 'runtimes' | 'sessions'
}> = ({ view }): ReactNode => {
    return (
        <TabbedPage
            activeId={view}
            ariaLabel='Agent management views'
            tabs={[
                { id: 'agents', label: 'Agents', to: adminRoutes.agents },
                {
                    id: 'runtimes',
                    label: 'Runtimes',
                    to: adminRoutes.runtimes
                },
                {
                    id: 'sessions',
                    label: 'Sessions',
                    to: adminRoutes.chatSessions
                }
            ]}
        >
            {view === 'agents' && <AgentsList />}
            {view === 'runtimes' && <AgentRuntimesList />}
            {view === 'sessions' && <ChatSessionsList />}
        </TabbedPage>
    )
}

export const FrameworksPage: FC<{
    tab: 'models' | 'versions' | 'provisioning'
}> = ({ tab }): ReactNode => {
    return (
        <TabbedPage
            activeId={tab}
            ariaLabel='Framework settings'
            tabs={[
                {
                    id: 'models',
                    label: 'Models',
                    to: adminRoutes.frameworkModels
                },
                {
                    id: 'versions',
                    label: 'Versions',
                    to: adminRoutes.frameworkVersions
                },
                {
                    id: 'provisioning',
                    label: 'Provisioning',
                    to: adminRoutes.frameworkProvisioning
                }
            ]}
        >
            {tab === 'models' && <FrameworkCatalogPage />}
            {tab === 'versions' && <FrameworkDefaultVersionsSettingsPage />}
            {tab === 'provisioning' && <FrameworkRuntimeDefaultsSettingsPage />}
        </TabbedPage>
    )
}

export const SkillsPage: FC<{
    tab: 'catalog' | 'sources' | 'categories'
}> = ({ tab }): ReactNode => {
    return (
        <TabbedPage
            activeId={tab}
            ariaLabel='Skill settings'
            tabs={[
                {
                    id: 'catalog',
                    label: 'Catalog',
                    to: adminRoutes.skillCatalog
                },
                {
                    id: 'sources',
                    label: 'Sources',
                    to: adminRoutes.skillSources
                },
                {
                    id: 'categories',
                    label: 'Categories',
                    to: adminRoutes.skillCategories
                }
            ]}
        >
            {tab === 'catalog' && <SkillsCatalogList />}
            {tab === 'sources' && <SkillReposSettingsPage />}
            {tab === 'categories' && <CatalogCategoriesPage domain='skill' />}
        </TabbedPage>
    )
}

export const McpPage: FC<{
    tab: 'catalog' | 'categories'
}> = ({ tab }): ReactNode => {
    return (
        <TabbedPage
            activeId={tab}
            ariaLabel='MCP settings'
            tabs={[
                {
                    id: 'catalog',
                    label: 'Catalog',
                    to: adminRoutes.mcpCatalog
                },
                {
                    id: 'categories',
                    label: 'Categories',
                    to: adminRoutes.mcpCategories
                }
            ]}
        >
            {tab === 'catalog' ? (
                <McpCatalogList />
            ) : (
                <CatalogCategoriesPage domain='mcp' />
            )}
        </TabbedPage>
    )
}

export const SelfOwnedComputersPage: FC<{
    view: 'machines' | 'client-policy'
}> = ({ view }): ReactNode => {
    return (
        <TabbedPage
            activeId={view}
            ariaLabel='Self-owned computer settings'
            tabs={[
                {
                    id: 'machines',
                    label: 'Machines',
                    to: adminRoutes.selfOwnedComputerMachines
                },
                {
                    id: 'client-policy',
                    label: 'Client policy',
                    to: adminRoutes.selfOwnedComputerClientPolicy
                }
            ]}
        >
            {view === 'machines' ? (
                <DaemonsList />
            ) : (
                <CliMinimumVersionSettingsPage />
            )}
        </TabbedPage>
    )
}

export const TurnPoliciesPage: FC = (): ReactNode => (
    <div className='mx-auto max-w-3xl'>
        <div className='mb-4'>
            <Heading level={2} className='mb-2'>
                Turn policies
            </Heading>
            <p className='admin-page-description'>
                Configure execution limits for direct chat and delegated A2A
                turns.
            </p>
        </div>
        <div className='space-y-4'>
            <ChatExecTimeoutsSettingsPage embedded />
            <A2aTurnTimeoutsSettingsPage embedded />
        </div>
    </div>
)

export const DataRetentionPage: FC = (): ReactNode => (
    <div className='mx-auto max-w-3xl'>
        <div className='mb-4'>
            <Heading level={2} className='mb-2'>
                Data retention
            </Heading>
            <p className='admin-page-description'>
                Configure how long deleted records stay recoverable before the
                background sweeps purge them permanently.
            </p>
        </div>
        <div className='space-y-4'>
            <AutomationRetentionSettingsPage embedded />
        </div>
    </div>
)

// Extracted into per-page files so the cloud overlay can shadow the mixed
// surfaces (editions §3.4); re-exported here to keep App.tsx imports stable.
export { AccountsPage } from '@/pages/consolidated/AccountsPage'
export { ModelProvidersPage } from '@/pages/consolidated/ModelProvidersPage'
export { RolloutsPage } from '@/pages/consolidated/RolloutsPage'
