import { Suspense, useEffect, type FC, type ReactNode } from 'react'
import { Navigate, Route, useLocation, useParams } from 'react-router-dom'
import ProtectedRoute from '@/components/ProtectedRoute'
import BootScreen from '@/components/BootScreen'
import { SentryRoutes } from '@/lib/sentry'
import { lazyChunk } from '@/lib/lazyChunk'
import { useAppAuth } from '@/lib/auth'
import Landing from '@/pages/Landing'

// The three layout chunks are named imports so they can also be warmed
// ahead of navigation — see useLayoutPrefetch.
const importAppShell = () => import('@/components/AppShell')
const importSettingsLayout = () => import('@/components/SettingsLayout')
const importCustomizeLayout = () => import('@/pages/Customize/CustomizeLayout')

const Challenge = lazyChunk(() => import('@/pages/Challenge'))
const ChallengeStatus = lazyChunk(() => import('@/pages/ChallengeStatus'))
const AppShell = lazyChunk(importAppShell)
const SettingsLayout = lazyChunk(importSettingsLayout)
const Login = lazyChunk(() => import('@/pages/Login'))
const CliLogin = lazyChunk(() => import('@/pages/CliLogin'))
const ConnectA2a = lazyChunk(() => import('@/pages/ConnectA2a'))
const GrantPermission = lazyChunk(() => import('@/pages/GrantPermission'))
const Invite = lazyChunk(() => import('@/pages/Invite'))
const AccountDeletionConfirm = lazyChunk(
    () => import('@/pages/AccountDeletionConfirm')
)
const AccountDeletionRestore = lazyChunk(
    () => import('@/pages/AccountDeletionRestore')
)
const SharedSkill = lazyChunk(() => import('@/pages/SharedSkill'))
const SharedChatSession = lazyChunk(() => import('@/pages/SharedChatSession'))
const Home = lazyChunk(() => import('@/pages/Home'))
const AgentNew = lazyChunk(() => import('@/pages/AgentNew'))
const AgentChat = lazyChunk(() => import('@/pages/AgentChat'))
const AgentSettings = lazyChunk(
    () => import('@/pages/AgentSettings/AgentSettings')
)
const LegacyAgentDetailRedirect = lazyChunk(
    () => import('@/pages/AgentSettings/LegacyAgentDetailRedirect')
)
const AgentRuntimesList = lazyChunk(() => import('@/pages/AgentRuntimesList'))
const Usage = lazyChunk(() => import('@/pages/Usage'))
const UsageEvents = lazyChunk(() => import('@/pages/UsageEvents'))
const CustomizeLayout = lazyChunk(importCustomizeLayout)
const SkillsCatalog = lazyChunk(() => import('@/pages/Customize/SkillsCatalog'))
const SkillDetail = lazyChunk(() => import('@/pages/Customize/SkillDetail'))
const LibrarySkills = lazyChunk(() => import('@/pages/Customize/LibrarySkills'))
const LibrarySkillEditor = lazyChunk(
    () => import('@/pages/Customize/LibrarySkillEditor')
)
const ConnectionsList = lazyChunk(
    () => import('@/pages/Customize/ConnectionsList')
)
const ConnectionDetail = lazyChunk(
    () => import('@/pages/Customize/ConnectionDetail')
)
const McpCatalog = lazyChunk(() => import('@/pages/Customize/McpCatalog'))
const McpDetail = lazyChunk(() => import('@/pages/Customize/McpDetail'))
const MyMcp = lazyChunk(() => import('@/pages/Customize/MyMcp'))
const SkillsRepos = lazyChunk(() => import('@/pages/Skills/SkillsRepos'))
const AutomationsList = lazyChunk(
    () => import('@/pages/Automations/AutomationsList')
)
const AutomationDetail = lazyChunk(
    () => import('@/pages/Automations/AutomationDetail')
)
const BuyContainer = lazyChunk(() => import('@/pages/Settings/BuyContainer'))
const CloudComputers = lazyChunk(
    () => import('@/pages/Settings/CloudComputers')
)
const General = lazyChunk(() => import('@/pages/Settings/General'))
const ApiTokens = lazyChunk(() => import('@/pages/Settings/ApiTokens'))
const ModelProviders = lazyChunk(
    () => import('@/pages/Settings/ModelProviders')
)
const Account = lazyChunk(() => import('@/pages/Settings/Account'))
const ManagedModelProviderNew = lazyChunk(
    () => import('@/pages/Settings/ManagedModelProviderNew')
)
const ManagedCreditHistory = lazyChunk(
    () => import('@/pages/Settings/ManagedCreditHistory')
)
const PlanAndBilling = lazyChunk(
    () => import('@/pages/Settings/PlanAndBilling')
)
const Pricing = lazyChunk(() => import('@/pages/Settings/Pricing'))
const SandboxUsage = lazyChunk(() => import('@/pages/Settings/SandboxUsage'))
const ChannelsList = lazyChunk(
    () => import('@/pages/Settings/Channels/ChannelsList')
)
const ChannelNew = lazyChunk(
    () => import('@/pages/Settings/Channels/ChannelNew')
)
const ChannelDetail = lazyChunk(
    () => import('@/pages/Settings/Channels/ChannelDetail')
)

const LegacyRuntimeDetailRedirect: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    return (
        <Navigate
            to={id ? `/settings/runtimes/${id}` : '/settings/runtimes'}
            replace
        />
    )
}

// Connections moved out of Settings into Customize. The search string has to
// survive the hop: the GitHub install callback redirects the browser to the old
// path with ?connected / ?error / ?reason, and the list page reads those.
const LegacyConnectionsRedirect: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const { search } = useLocation()
    return (
        <Navigate to={`/connections${id ? `/${id}` : ''}${search}`} replace />
    )
}

// The area's own default section. The search string rides along because the
// params are the target's to read (`?configureModel=1` opens a dialog there).
const AgentSettingsIndexRedirect: FC = (): ReactNode => {
    const { search } = useLocation()
    return <Navigate to={`overview${search}`} replace />
}

// Once signed in, warm the layout chunks while the browser is idle. This
// boundary is app boot, so its fallback is the boot screen — a layout
// chunk that suspended mid-session would flash that boot screen and read
// as the app restarting. Warming them means the only boundary a session
// navigation can hit is the per-layout one, which keeps chrome on screen.
const useLayoutPrefetch = (): void => {
    const { isLoaded, isSignedIn } = useAppAuth()
    useEffect(() => {
        if (!isLoaded || !isSignedIn) return
        // Warming is best effort and nothing on screen is waiting for it, so
        // a stale-deploy miss here must not reload the tab out from under the
        // user; the vite:preloadError listener still reports it, and recovery
        // happens at the lazy boundary they actually navigate to.
        const ignore = (): void => {}
        const warm = (): void => {
            void importAppShell().catch(ignore)
            void importSettingsLayout().catch(ignore)
            void importCustomizeLayout().catch(ignore)
        }
        if (!window.requestIdleCallback) {
            const timer = setTimeout(warm, 1200)
            return () => clearTimeout(timer)
        }
        const handle = window.requestIdleCallback(warm)
        return () => window.cancelIdleCallback(handle)
    }, [isLoaded, isSignedIn])
}

const App: FC = (): ReactNode => {
    useLayoutPrefetch()
    return (
        <Suspense fallback={<BootScreen />}>
            <SentryRoutes>
                <Route path='/' element={<Landing />} />
                <Route path='/zh' element={<Landing />} />
                <Route path='/challenge' element={<Challenge />} />
                {/* Public on purpose: the signed-out state is one of the
                    states this page renders, so a route guard would bounce
                    people out before they can see it. */}
                <Route path='/challenge/status' element={<ChallengeStatus />} />
                <Route path='/login/*' element={<Login />} />
                <Route path='/cli-login' element={<CliLogin />} />
                <Route path='/connect/a2a' element={<ConnectA2a />} />
                <Route path='/grant-permission' element={<GrantPermission />} />
                {/* Both deletion pages handle auth themselves: confirm
                    round-trips through login with the token preserved, and
                    restore MUST work signed-out (post-T0 there is no
                    session — the emailed token is the credential). */}
                <Route
                    path='/account/deletion/confirm'
                    element={<AccountDeletionConfirm />}
                />
                <Route
                    path='/account/deletion/restore'
                    element={<AccountDeletionRestore />}
                />
                <Route path='/invite/:token' element={<Invite />} />
                <Route
                    path='/skills/shared/:shareId'
                    element={<SharedSkill />}
                />
                <Route
                    path='/chat/shared/:shareId'
                    element={<SharedChatSession />}
                />
                <Route
                    element={
                        <ProtectedRoute>
                            <AppShell />
                        </ProtectedRoute>
                    }
                >
                    <Route path='/workspace' element={<Home />} />
                    <Route
                        path='/agents'
                        element={<Navigate to='/workspace' replace />}
                    />
                    <Route path='/agents/new' element={<AgentNew />} />
                    <Route
                        path='/agents/:id'
                        element={<LegacyAgentDetailRedirect />}
                    />
                    <Route path='/agents/:id/chat' element={<AgentChat />} />
                    <Route path='/automations' element={<AutomationsList />} />
                    <Route
                        path='/automations/:id'
                        element={<AutomationDetail />}
                    />
                </Route>
                <Route
                    path='/agents/:id/settings'
                    element={
                        <ProtectedRoute>
                            <AgentSettingsIndexRedirect />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/agents/:id/settings/:section'
                    element={
                        <ProtectedRoute>
                            <AgentSettings />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/skills/discover'
                    element={<Navigate to='/skills' replace />}
                />
                <Route
                    element={
                        <ProtectedRoute>
                            <CustomizeLayout />
                        </ProtectedRoute>
                    }
                >
                    <Route path='/skills' element={<SkillsCatalog />} />
                    <Route path='/skills/library' element={<LibrarySkills />} />
                    <Route path='/skills/repos' element={<SkillsRepos />} />
                    <Route path='/skills/detail' element={<SkillDetail />} />
                    <Route
                        path='/skills/library/edit'
                        element={<LibrarySkillEditor />}
                    />
                    <Route path='/mcp' element={<McpCatalog />} />
                    <Route path='/mcp/library' element={<MyMcp />} />
                    <Route path='/mcp/:serverId' element={<McpDetail />} />
                    <Route path='/connections' element={<ConnectionsList />} />
                    <Route
                        path='/connections/:id'
                        element={<ConnectionDetail />}
                    />
                </Route>
                <Route
                    path='/connectors'
                    element={<Navigate to='/connections' replace />}
                />
                <Route
                    path='/connectors/:provider'
                    element={<Navigate to='/connections' replace />}
                />
                <Route
                    path='/settings'
                    element={
                        <ProtectedRoute>
                            <SettingsLayout />
                        </ProtectedRoute>
                    }
                >
                    <Route index element={<Navigate to='general' replace />} />
                    <Route path='general' element={<General />} />
                    <Route path='runtimes/*' element={<AgentRuntimesList />} />
                    <Route
                        path='cloud-computers'
                        element={<CloudComputers />}
                    />
                    <Route
                        path='local-daemons'
                        element={
                            <Navigate
                                to='/settings/runtimes/local-daemons'
                                replace
                            />
                        }
                    />
                    <Route path='api-tokens' element={<ApiTokens />} />
                    <Route
                        path='plan-and-billing'
                        element={<PlanAndBilling />}
                    />
                    <Route
                        path='plan-and-billing/pricing'
                        element={<Pricing />}
                    />
                    <Route
                        path='plan-and-billing/buy-container'
                        element={<BuyContainer />}
                    />
                    <Route
                        path='plan-and-billing/sandbox-usage'
                        element={<SandboxUsage />}
                    />
                    <Route path='usage' element={<Usage />} />
                    <Route path='usage/events' element={<UsageEvents />} />
                    <Route
                        path='model-providers/*'
                        element={<ModelProviders />}
                    />
                    <Route
                        path='connections'
                        element={<LegacyConnectionsRedirect />}
                    />
                    <Route
                        path='connections/:id'
                        element={<LegacyConnectionsRedirect />}
                    />
                    <Route path='account' element={<Account />} />
                    <Route
                        path='model-providers/managed/new'
                        element={<ManagedModelProviderNew />}
                    />
                    <Route
                        path='model-providers/managed/credit-history'
                        element={<ManagedCreditHistory />}
                    />
                    <Route
                        path='external-agent-providers'
                        element={
                            <Navigate
                                to='/settings/runtimes/external-agent-providers'
                                replace
                            />
                        }
                    />
                    <Route path='channels' element={<ChannelsList />}>
                        <Route path=':id' element={<ChannelDetail />} />
                        <Route path='new/:provider' element={<ChannelNew />} />
                    </Route>
                    <Route
                        path='skills'
                        element={<Navigate to='/skills' replace />}
                    />
                    <Route
                        path='skills/discover'
                        element={<Navigate to='/skills' replace />}
                    />
                    <Route
                        path='skills/repos'
                        element={<Navigate to='/skills/repos' replace />}
                    />
                </Route>
                <Route
                    path='/agent-runtimes'
                    element={
                        <ProtectedRoute>
                            <Navigate to='/settings/runtimes' replace />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/agent-runtimes/new'
                    element={
                        <ProtectedRoute>
                            <Navigate to='/settings/runtimes/sandbox' replace />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/agent-runtimes/:id'
                    element={
                        <ProtectedRoute>
                            <LegacyRuntimeDetailRedirect />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/usage'
                    element={
                        <ProtectedRoute>
                            <Navigate to='/settings/usage' replace />
                        </ProtectedRoute>
                    }
                />
                <Route
                    path='/usage/events'
                    element={
                        <ProtectedRoute>
                            <Navigate to='/settings/usage/events' replace />
                        </ProtectedRoute>
                    }
                />
                <Route path='*' element={<Navigate to='/' replace />} />
            </SentryRoutes>
        </Suspense>
    )
}

export default App
