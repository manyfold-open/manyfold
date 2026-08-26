import type { FC, ReactNode } from 'react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppShellContext } from '@/components/AppShell'
import EmptyState from '@/components/EmptyState'
import { AgentIcon } from '@/components/icons'
import { SheenText } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useI18n } from '@/lib/i18n'

const Home: FC = (): ReactNode => {
    const navigate = useNavigate()
    const { t } = useI18n()
    const { agents, agentsError, agentsLoading } = useAppShellContext()
    // Only the loading line is gated: an account with agents redirects before
    // anything paints, and one without them now has a page of its own to
    // arrive at, so nothing is waiting on a fetch to decide what to show.
    const gate = useLoadingGate(agentsLoading)

    // An account with no agents used to be forwarded to the create form, which
    // made the workspace a route that could not be visited: "back to workspace"
    // bounced straight here again, and the form had to hide its own close
    // button because there was nowhere to close back to. The workspace answers
    // for itself now, and creating is the one action it offers.
    useEffect(() => {
        if (agentsLoading || agents.length === 0) return
        navigate(`/agents/${agents[0].id}/chat`, { replace: true })
    }, [agents, agentsLoading, navigate])

    const empty = !agentsLoading && !agentsError && agents.length === 0

    return (
        <div className='bg-main flex min-h-full flex-col overflow-auto'>
            <div className='workbench-page-narrow flex flex-1 flex-col justify-center'>
                <section className='mx-auto w-full max-w-2xl py-8'>
                    {agentsError ? (
                        <div className='workbench-alert-error text-left'>
                            {agentsError}
                        </div>
                    ) : empty ? (
                        <EmptyState
                            kind='first-use'
                            tier='stack'
                            icon={AgentIcon}
                            title={t('web.emptyState.agentsTitle')}
                            body={t('web.emptyState.agentsWorkspaceBody')}
                            action={{
                                label: t('web.emptyState.agentsCreateAction'),
                                onClick: () => navigate('/agents/new')
                            }}
                        />
                    ) : gate.showLoading ? (
                        <SheenText className='text-ui text-muted'>
                            {t('web.home.loadingAgents')}
                        </SheenText>
                    ) : null}
                </section>
            </div>
        </div>
    )
}

export default Home
