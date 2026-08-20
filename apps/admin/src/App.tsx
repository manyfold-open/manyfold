import type { FC, ReactNode } from 'react'
import { Navigate, Route, useParams, useSearchParams } from 'react-router-dom'
import { SentryRoutes } from '@/lib/sentry'
import AppLayout from '@/components/AppLayout'
import ProtectedRoute from '@/components/ProtectedRoute'
import Setup from '@/pages/Setup'
import Login from '@/pages/Login'
import Dashboard from '@/pages/Dashboard'
import AgentNew from '@/pages/Agents/AgentNew'
import AgentDetail from '@/pages/Agents/AgentDetail'
import AgentRuntimeDetail from '@/pages/AgentRuntimes/AgentRuntimeDetail'
import ChatSessionDetail from '@/pages/ChatSessions/ChatSessionDetail'
import SandboxesList from '@/pages/Sandboxes/SandboxesList'
import SandboxNew from '@/pages/Sandboxes/SandboxNew'
import ClustersList from '@/pages/Clusters/ClustersList'
import ClusterForm from '@/pages/Clusters/ClusterForm'
import SpritesAccountsList from '@/pages/SpritesAccounts/SpritesAccountsList'
import SpritesAccountForm from '@/pages/SpritesAccounts/SpritesAccountForm'
import NotificationWebhooksList from '@/pages/NotificationWebhooks/NotificationWebhooksList'
import NotificationWebhookForm from '@/pages/NotificationWebhooks/NotificationWebhookForm'
import UserDetail from '@/pages/Users/UserDetail'
import LoginProviderSettingsPage from '@/pages/LoginProviderSettings'
import EmailProviderSettingsPage from '@/pages/EmailProviderSettings'
import McpCatalogForm from '@/pages/Catalog/McpCatalogForm'
import SandboxQuotas from '@/pages/SandboxQuotas/SandboxQuotas'
import ChannelsList from '@/pages/Channels/ChannelsList'
import ChannelNew from '@/pages/Channels/ChannelNew'
import ChannelDetail from '@/pages/Channels/ChannelDetail'
import {
    AccountsPage,
    AgentManagementPage,
    FrameworksPage,
    DataRetentionPage,
    McpPage,
    ModelProvidersPage,
    RolloutsPage,
    SelfOwnedComputersPage,
    SkillsPage,
    TurnPoliciesPage
} from '@/pages/ConsolidatedPages'
import { adminRoutes } from '@/routes'
import { rolloutsHomeRoute } from '@/rollouts-home'
import {
    extraAdminRoutes,
    extraLegacyParamRedirects,
    extraLegacyPathRedirects,
    extraLegacyQueryTargets
} from '@/routes-extra'

interface LegacyRedirect {
    from: string
    to: string
}

const legacyStaticRedirects: LegacyRedirect[] = [
    { from: '/agent-runtimes', to: adminRoutes.runtimes },
    { from: '/agent-runtimes/new', to: adminRoutes.agentNew },
    { from: '/providers', to: adminRoutes.modelProviders },
    { from: '/settings/clusters', to: adminRoutes.clusters },
    { from: '/settings/clusters/new', to: adminRoutes.clusterNew },
    {
        from: '/settings/stateful-sandbox-accounts',
        to: adminRoutes.sandboxAccounts
    },
    {
        from: '/settings/stateful-sandbox-accounts/new',
        to: adminRoutes.sandboxAccountNew
    },
    { from: '/settings/sprites-accounts', to: adminRoutes.sandboxAccounts },
    {
        from: '/settings/sprites-accounts/new',
        to: adminRoutes.sandboxAccountNew
    },
    {
        from: '/settings/notification-webhooks',
        to: adminRoutes.notificationWebhooks
    },
    {
        from: '/settings/notification-webhooks/new',
        to: adminRoutes.notificationWebhookNew
    },
    { from: '/settings/users', to: adminRoutes.accountUsers },
    {
        from: '/settings/subscriptions',
        to: adminRoutes.billingSubscriptions
    },
    { from: '/settings/payments', to: adminRoutes.billingPayments },
    {
        from: '/settings/login-provider',
        to: adminRoutes.platformAuthentication
    },
    { from: '/settings/email-provider', to: adminRoutes.platformEmail },
    {
        from: '/settings/daemons',
        to: adminRoutes.selfOwnedComputerMachines
    },
    {
        from: '/settings/framework-catalog',
        to: adminRoutes.frameworkModels
    },
    {
        from: '/settings/framework-runtime-defaults',
        to: adminRoutes.frameworkProvisioning
    },
    {
        from: '/settings/framework-default-versions',
        to: adminRoutes.frameworkVersions
    },
    { from: '/settings/skill-repos', to: adminRoutes.skillSources },
    { from: '/settings/skills-catalog', to: adminRoutes.skillCatalog },
    { from: '/settings/mcp-catalog', to: adminRoutes.mcpCatalog },
    { from: '/settings/mcp-catalog/new', to: adminRoutes.mcpCatalogNew },
    {
        from: '/settings/catalog-categories',
        to: adminRoutes.skillCategories
    },
    {
        from: '/settings/sandbox-capacity',
        to: adminRoutes.sandboxCapacity
    },
    {
        from: '/settings/sprites-wholesale-cap',
        to: adminRoutes.sandboxCapacity
    },
    {
        from: '/settings/sandbox-quotas',
        to: adminRoutes.sandboxCapacity
    },
    { from: '/settings/turn-policies', to: adminRoutes.turnPolicies },
    { from: '/settings/chat-exec-timeouts', to: adminRoutes.turnPolicies },
    { from: '/settings/a2a-turn-timeouts', to: adminRoutes.turnPolicies },
    {
        from: '/settings/cli-minimum-version',
        to: adminRoutes.selfOwnedComputerClientPolicy
    },
    {
        from: '/settings/experiments',
        to: adminRoutes.rolloutExperiments
    },
    {
        from: '/settings/feature-toggles',
        to: adminRoutes.rolloutFeatureFlags
    }
]

interface LegacyParamRedirectDefinition {
    from: string
    name: string
    to: (value: string) => string
}

const legacyParamRedirects: LegacyParamRedirectDefinition[] = [
    {
        from: '/agent-runtimes/:id',
        name: 'id',
        to: adminRoutes.runtime
    },
    {
        from: '/settings/clusters/:id',
        name: 'id',
        to: adminRoutes.cluster
    },
    {
        from: '/settings/stateful-sandbox-accounts/:slug',
        name: 'slug',
        to: adminRoutes.sandboxAccount
    },
    {
        from: '/settings/sprites-accounts/:slug',
        name: 'slug',
        to: adminRoutes.sandboxAccount
    },
    {
        from: '/settings/notification-webhooks/:id',
        name: 'id',
        to: adminRoutes.notificationWebhook
    },
    {
        from: '/settings/users/:id',
        name: 'id',
        to: adminRoutes.accountUser
    },
    {
        from: '/settings/mcp-catalog/:id',
        name: 'id',
        to: adminRoutes.mcpCatalogItem
    },
    {
        from: '/settings/experiments/:key',
        name: 'key',
        to: adminRoutes.experiment
    }
]

interface LegacyQueryRedirectDefinition {
    fallback: string
    from: string
    name: string
    targets: Record<string, string>
}

const legacyQueryRedirects: LegacyQueryRedirectDefinition[] = [
    {
        from: '/settings/accounts',
        name: 'view',
        fallback: adminRoutes.accountUsers,
        targets: {
            users: adminRoutes.accountUsers
        }
    },
    {
        from: '/settings/billing',
        name: 'view',
        fallback: adminRoutes.billingSubscriptions,
        targets: {
            subscriptions: adminRoutes.billingSubscriptions,
            invoices: adminRoutes.billingInvoices,
            payments: adminRoutes.billingPayments
        }
    },
    {
        from: '/settings/frameworks',
        name: 'tab',
        fallback: adminRoutes.frameworkModels,
        targets: {
            models: adminRoutes.frameworkModels,
            versions: adminRoutes.frameworkVersions,
            provisioning: adminRoutes.frameworkProvisioning
        }
    },
    {
        from: '/settings/skills',
        name: 'tab',
        fallback: adminRoutes.skillCatalog,
        targets: {
            catalog: adminRoutes.skillCatalog,
            sources: adminRoutes.skillSources,
            categories: adminRoutes.skillCategories
        }
    },
    {
        from: '/settings/mcp',
        name: 'tab',
        fallback: adminRoutes.mcpCatalog,
        targets: {
            catalog: adminRoutes.mcpCatalog,
            categories: adminRoutes.mcpCategories
        }
    },
    {
        from: '/settings/self-owned-computers',
        name: 'view',
        fallback: adminRoutes.selfOwnedComputerMachines,
        targets: {
            machines: adminRoutes.selfOwnedComputerMachines,
            'client-policy': adminRoutes.selfOwnedComputerClientPolicy
        }
    },
    {
        from: '/settings/rollouts',
        name: 'view',
        fallback: rolloutsHomeRoute,
        targets: {
            experiments: adminRoutes.rolloutExperiments,
            features: adminRoutes.rolloutFeatureFlags
        }
    }
]

const LegacyParamRedirect: FC<{
    name: string
    to: (value: string) => string
}> = ({ name, to }): ReactNode => {
    const params = useParams()
    return <Navigate replace to={to(params[name] ?? '')} />
}

const LegacyQueryRedirect: FC<{
    fallback: string
    name: string
    targets: Record<string, string>
}> = ({ fallback, name, targets }): ReactNode => {
    const [params] = useSearchParams()
    return <Navigate replace to={targets[params.get(name) ?? ''] ?? fallback} />
}

const AgentsRoute: FC = (): ReactNode => {
    const [params] = useSearchParams()
    if (!params.has('view')) return <AgentManagementPage view='agents' />
    return (
        <Navigate
            replace
            to={
                params.get('view') === 'runtimes'
                    ? adminRoutes.runtimes
                    : adminRoutes.agents
            }
        />
    )
}

const App: FC = (): ReactNode => {
    return (
        <SentryRoutes>
            <Route path={adminRoutes.setup} element={<Setup />} />
            <Route path={`${adminRoutes.login}/*`} element={<Login />} />
            <Route
                element={
                    <ProtectedRoute>
                        <AppLayout />
                    </ProtectedRoute>
                }
            >
                <Route path={adminRoutes.dashboard} element={<Dashboard />} />

                <Route path={adminRoutes.agents} element={<AgentsRoute />} />
                <Route path={adminRoutes.agentNew} element={<AgentNew />} />
                <Route
                    path={adminRoutes.agentDetail}
                    element={<AgentDetail />}
                />
                <Route
                    path={adminRoutes.runtimes}
                    element={<AgentManagementPage view='runtimes' />}
                />
                <Route
                    path={adminRoutes.runtimeDetail}
                    element={<AgentRuntimeDetail />}
                />
                <Route
                    path={adminRoutes.chatSessions}
                    element={<AgentManagementPage view='sessions' />}
                />
                <Route
                    path={adminRoutes.chatSessionDetail}
                    element={<ChatSessionDetail />}
                />
                <Route
                    path={adminRoutes.sandboxes}
                    element={<SandboxesList />}
                />
                <Route path={adminRoutes.sandboxNew} element={<SandboxNew />} />
                <Route path={adminRoutes.channels} element={<ChannelsList />} />
                <Route path={adminRoutes.channelNew} element={<ChannelNew />} />
                <Route
                    path={adminRoutes.channelDetail}
                    element={<ChannelDetail />}
                />
                <Route
                    path={adminRoutes.modelProviders}
                    element={
                        <Navigate replace to={adminRoutes.modelProviderKeys} />
                    }
                />
                <Route
                    path={adminRoutes.modelProviderKeys}
                    element={<ModelProvidersPage view='keys' />}
                />
                <Route
                    path={adminRoutes.modelProviderBuiltInPrices}
                    element={<ModelProvidersPage view='built-in-prices' />}
                />

                <Route
                    path={adminRoutes.infrastructure}
                    element={<Navigate replace to={adminRoutes.clusters} />}
                />
                <Route path={adminRoutes.clusters} element={<ClustersList />} />
                <Route
                    path={adminRoutes.clusterNew}
                    element={<ClusterForm />}
                />
                <Route
                    path={adminRoutes.clusterDetail}
                    element={<ClusterForm />}
                />
                <Route
                    path={adminRoutes.sandboxAccounts}
                    element={<SpritesAccountsList />}
                />
                <Route
                    path={adminRoutes.sandboxAccountNew}
                    element={<SpritesAccountForm />}
                />
                <Route
                    path={adminRoutes.sandboxAccountDetail}
                    element={<SpritesAccountForm />}
                />
                <Route
                    path={adminRoutes.selfOwnedComputers}
                    element={
                        <Navigate
                            replace
                            to={adminRoutes.selfOwnedComputerMachines}
                        />
                    }
                />
                <Route
                    path={adminRoutes.selfOwnedComputerMachines}
                    element={<SelfOwnedComputersPage view='machines' />}
                />
                <Route
                    path={adminRoutes.selfOwnedComputerClientPolicy}
                    element={<SelfOwnedComputersPage view='client-policy' />}
                />
                <Route
                    path={adminRoutes.sandboxCapacity}
                    element={<SandboxQuotas />}
                />

                <Route
                    path={adminRoutes.accounts}
                    element={<Navigate replace to={adminRoutes.accountUsers} />}
                />
                <Route
                    path={adminRoutes.accountUsers}
                    element={<AccountsPage view='users' />}
                />
                <Route
                    path={adminRoutes.accountUserDetail}
                    element={<UserDetail />}
                />

                <Route
                    path={adminRoutes.catalog}
                    element={
                        <Navigate replace to={adminRoutes.frameworkModels} />
                    }
                />
                <Route
                    path={adminRoutes.frameworkCatalog}
                    element={
                        <Navigate replace to={adminRoutes.frameworkModels} />
                    }
                />
                <Route
                    path={adminRoutes.frameworkModels}
                    element={<FrameworksPage tab='models' />}
                />
                <Route
                    path={adminRoutes.frameworkVersions}
                    element={<FrameworksPage tab='versions' />}
                />
                <Route
                    path={adminRoutes.frameworkProvisioning}
                    element={<FrameworksPage tab='provisioning' />}
                />
                <Route
                    path={adminRoutes.skillCatalogRoot}
                    element={<Navigate replace to={adminRoutes.skillCatalog} />}
                />
                <Route
                    path={adminRoutes.skillCatalog}
                    element={<SkillsPage tab='catalog' />}
                />
                <Route
                    path={adminRoutes.skillSources}
                    element={<SkillsPage tab='sources' />}
                />
                <Route
                    path={adminRoutes.skillCategories}
                    element={<SkillsPage tab='categories' />}
                />
                <Route
                    path={adminRoutes.mcpRoot}
                    element={<Navigate replace to={adminRoutes.mcpCatalog} />}
                />
                <Route
                    path={adminRoutes.mcpCatalog}
                    element={<McpPage tab='catalog' />}
                />
                <Route
                    path={adminRoutes.mcpCatalogNew}
                    element={<McpCatalogForm />}
                />
                <Route
                    path={adminRoutes.mcpCatalogDetail}
                    element={<McpCatalogForm />}
                />
                <Route
                    path={adminRoutes.mcpCategories}
                    element={<McpPage tab='categories' />}
                />

                <Route
                    path={adminRoutes.platform}
                    element={
                        <Navigate
                            replace
                            to={adminRoutes.platformAuthentication}
                        />
                    }
                />
                <Route
                    path={adminRoutes.platformAuthentication}
                    element={<LoginProviderSettingsPage />}
                />
                <Route
                    path={adminRoutes.platformEmail}
                    element={<EmailProviderSettingsPage />}
                />
                <Route
                    path={adminRoutes.notificationWebhooks}
                    element={<NotificationWebhooksList />}
                />
                <Route
                    path={adminRoutes.notificationWebhookNew}
                    element={<NotificationWebhookForm />}
                />
                <Route
                    path={adminRoutes.notificationWebhookDetail}
                    element={<NotificationWebhookForm />}
                />
                <Route
                    path={adminRoutes.turnPolicies}
                    element={<TurnPoliciesPage />}
                />
                <Route
                    path={adminRoutes.dataRetention}
                    element={<DataRetentionPage />}
                />
                <Route
                    path={adminRoutes.rollouts}
                    element={
                        <Navigate replace to={rolloutsHomeRoute} />
                    }
                />
                <Route
                    path={adminRoutes.rolloutFeatureFlags}
                    element={<RolloutsPage view='features' />}
                />

                {[...legacyStaticRedirects, ...extraLegacyPathRedirects].map(
                    ({ from, to }) => (
                        <Route
                            key={from}
                            path={from}
                            element={<Navigate replace to={to} />}
                        />
                    )
                )}
                {[...legacyParamRedirects, ...extraLegacyParamRedirects].map(
                    ({ from, name, to }) => (
                        <Route
                            key={from}
                            path={from}
                            element={
                                <LegacyParamRedirect name={name} to={to} />
                            }
                        />
                    )
                )}
                {legacyQueryRedirects.map(
                    ({ fallback, from, name, targets }) => (
                        <Route
                            key={from}
                            path={from}
                            element={
                                <LegacyQueryRedirect
                                    fallback={fallback}
                                    name={name}
                                    targets={{
                                        ...targets,
                                        ...extraLegacyQueryTargets[from]
                                    }}
                                />
                            }
                        />
                    )
                )}
                {extraAdminRoutes.map((route) => (
                    <Route
                        key={route.path}
                        path={route.path}
                        element={route.element}
                    />
                ))}
            </Route>
            <Route
                path='*'
                element={<Navigate to={adminRoutes.dashboard} replace />}
            />
        </SentryRoutes>
    )
}

export default App
