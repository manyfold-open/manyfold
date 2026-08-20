import { isSkillFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { frameworkLabel } from '@/lib/frameworkMeta'
import AgentSkillsPanel from '@/pages/Skills/AgentSkillsPanel'

interface Props {
    agent: SdkAgent
}

export const AgentSkills: FC<Props> = ({ agent }): ReactNode => {
    if (!isSkillFramework(agent.framework) || !agent.runtimeId) return null
    return (
        <section>
            <header className='mb-4'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg tracking-tight'>
                        {t('web.agents.detail.skills.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='next-turn' />
                </div>
                <p className='text-caption text-muted mt-1.5'>
                    {t('web.agents.detail.skills.description', {
                        framework: frameworkLabel(agent.framework)
                    })}
                </p>
            </header>
            <AgentSkillsPanel agentId={agent.id} />
        </section>
    )
}
