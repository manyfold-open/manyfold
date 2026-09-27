import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppAuthProvider } from '@/lib/auth'
import { I18nProvider, i18nReady } from '@/lib/i18n'
import AgentSettings from '@/pages/AgentSettings/AgentSettings'
import LegacyAgentDetailRedirect from '@/pages/AgentSettings/LegacyAgentDetailRedirect'
import AgentCredentialsDialog from '@/components/chat/AgentCredentialsDialog'
import '@/styles.css'

const router = createBrowserRouter([
    { path: '/provider-dialog', element: <AgentCredentialsDialog agentId='a' agentName='Antigravity fixture' framework='antigravity-cli' onClose={() => {}} /> },
    { path: '/agents/:id/settings/:section', element: <AgentSettings /> },
    { path: '/agents/:id', element: <LegacyAgentDetailRedirect /> }
])

declare global {
    interface Window {
        settingsNavigate: (path: string) => Promise<void>
    }
}

window.settingsNavigate = (path) => router.navigate(path)
await i18nReady
createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <AppAuthProvider>
            <RouterProvider router={router} />
        </AppAuthProvider>
    </I18nProvider>
)
