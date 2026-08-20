import type { FC, ReactNode } from 'react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppShellContext } from '@/components/AppShell'
import { SheenText } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useI18n } from '@/lib/i18n'

const Home: FC = (): ReactNode => {
    const navigate = useNavigate()
    const { t } = useI18n()
    const { agents, agentsError, agentsLoading } = useAppShellContext()
    // Home only redirects, so there is no layout to ghost — the §10.8
    // line tier is the right register, gated so a warm agent list
    // redirects with no flash of copy at all.
    const gate = useLoadingGate(agentsLoading)

    useEffect(() => {
        if (agentsLoading) return
        navigate(
            agents.length > 0 ? `/agents/${agents[0].id}/chat` : '/agents/new',
            {
                replace: true
            }
        )
    }, [agents, agentsLoading, navigate])

    return (
        <div className='bg-main flex min-h-full flex-col overflow-auto'>
            <div className='workbench-page-narrow flex flex-1 flex-col justify-center'>
                <section className='mx-auto w-full max-w-2xl py-8'>
                    {agentsError ? (
                        <div className='workbench-alert-error text-left'>
                            {agentsError}
                        </div>
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
