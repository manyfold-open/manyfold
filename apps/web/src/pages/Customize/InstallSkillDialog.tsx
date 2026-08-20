import {
    DiscoverableSkillSummary,
    isSkillFramework
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import ProductDialog from '@/components/ProductDialog'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { useApiClient } from '@/lib/apiClient'
import { SheenText, Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import AgentPicker from '@/pages/Automations/AgentPicker'

interface Props {
    skill: DiscoverableSkillSummary
    onClose: () => void
}

const InstallSkillDialog: FC<Props> = ({ skill, onClose }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [installedAgentIds, setInstalledAgentIds] = useState<Set<string>>(
        new Set()
    )
    const [selectedAgentId, setSelectedAgentId] = useState('')
    const [loading, setLoading] = useState(true)
    const [installing, setInstalling] = useState(false)
    const [installedTo, setInstalledTo] = useState<SdkAgent | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        Promise.all([client.agents.list(), client.skills.installed()])
            .then(([allAgents, groups]) => {
                if (cancelled) return
                setAgents(
                    allAgents.filter(
                        (agent) =>
                            isSkillFramework(agent.framework) &&
                            agent.runtimeId
                    )
                )
                setInstalledAgentIds(
                    new Set(
                        groups
                            .filter((group) =>
                                group.skills.some(
                                    (item) => item.skillId === skill.skillId
                                )
                            )
                            .map((group) => group.agent.id)
                    )
                )
                setError(null)
            })
            .catch((err: unknown) => {
                if (!cancelled) setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, skill.skillId])

    const selectedAgent = useMemo(
        () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
        [agents, selectedAgentId]
    )
    const alreadyInstalled = selectedAgent
        ? installedAgentIds.has(selectedAgent.id)
        : false

    const install = async (): Promise<void> => {
        if (!selectedAgent || alreadyInstalled || installing) return
        setInstalling(true)
        setError(null)
        try {
            await client.skills.install({
                skillId: skill.skillId,
                agentId: selectedAgent.id
            })
            setInstalledTo(selectedAgent)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setInstalling(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.customize.installToAgent')}
            description={skill.name}
            onClose={onClose}
            closeDisabled={installing}
            footer={
                installedTo ? (
                    <button
                        type='button'
                        onClick={onClose}
                        className='workbench-button-secondary'
                    >
                        {t('common.close')}
                    </button>
                ) : (
                    <>
                        <button
                            type='button'
                            onClick={onClose}
                            disabled={installing}
                            className='workbench-button-secondary'
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type='button'
                            onClick={() => void install()}
                            disabled={
                                !selectedAgent || alreadyInstalled || installing
                            }
                            className='workbench-button-primary'
                        >
                            {installing ? (
                                <>
                                    <Spinner size={16} className='mr-2' />
                                    {t('common.installing')}
                                </>
                            ) : (
                                t('web.skills.installAction')
                            )}
                        </button>
                    </>
                )
            }
        >
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {installedTo ? (
                <div className='py-2'>
                    <p className='text-ui text-fg'>
                        {t('web.customize.installSuccess', {
                            agent: installedTo.name
                        })}
                    </p>
                    <Link
                        to={agentSettingsPath(installedTo.id, 'skills')}
                        onClick={onClose}
                        className='text-ui text-muted hover:text-fg mt-2 inline-flex font-medium transition-colors'
                    >
                        {t('web.customize.viewInAgent')}
                    </Link>
                </div>
            ) : loading ? (
                <SheenText className='text-ui text-muted'>
                    {t('common.loading')}
                </SheenText>
            ) : agents.length === 0 ? (
                <div className='py-2'>
                    <p className='text-ui text-muted'>
                        {t('web.customize.noSkillAgents')}
                    </p>
                    <Link
                        to='/agents/new'
                        onClick={onClose}
                        className='text-ui text-fg mt-2 inline-flex font-medium underline-offset-4 hover:underline'
                    >
                        {t('web.skills.createAgentAction')}
                    </Link>
                </div>
            ) : (
                <div className='py-1'>
                    <label className='text-caption text-muted mb-2 block'>
                        {t('web.customize.selectAgent')}
                    </label>
                    <AgentPicker
                        agents={agents}
                        selectedAgentId={selectedAgentId}
                        onSelect={setSelectedAgentId}
                        placeholder={t('web.customize.selectAgent')}
                        disabled={installing}
                    />
                    {alreadyInstalled && (
                        <p className='text-caption text-muted mt-3'>
                            {t('web.customize.alreadyInstalled')}
                        </p>
                    )}
                </div>
            )}
        </ProductDialog>
    )
}

export default InstallSkillDialog
