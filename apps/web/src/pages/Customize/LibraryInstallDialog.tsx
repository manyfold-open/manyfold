import {
    InstallSkillBatchResultItem,
    isSkillFramework
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import ProductDialog from '@/components/ProductDialog'
import { useApiClient } from '@/lib/apiClient'
import { SheenText, Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

interface Props {
    skillId: string
    name: string
    onClose: () => void
}

const LibraryInstallDialog: FC<Props> = ({
    skillId,
    name,
    onClose
}): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [installedAgentIds, setInstalledAgentIds] = useState<Set<string>>(
        new Set()
    )
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState(true)
    const [installing, setInstalling] = useState(false)
    const [results, setResults] = useState<
        InstallSkillBatchResultItem[] | null
    >(null)
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
                                    (item) => item.skillId === skillId
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
    }, [client, skillId])

    const agentById = useMemo(
        () => new Map(agents.map((agent) => [agent.id, agent])),
        [agents]
    )

    const toggle = (agentId: string): void => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(agentId)) next.delete(agentId)
            else next.add(agentId)
            return next
        })
    }

    const install = async (): Promise<void> => {
        if (selectedIds.size === 0 || installing) return
        setInstalling(true)
        setError(null)
        try {
            const res = await client.skills.installBatch({
                skillId,
                agentIds: [...selectedIds]
            })
            setResults(res.results)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setInstalling(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.customize.installToAgent')}
            description={name}
            onClose={onClose}
            closeDisabled={installing}
            footer={
                results ? (
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
                            disabled={selectedIds.size === 0 || installing}
                            className='workbench-button-primary'
                        >
                            {installing ? (
                                <>
                                    <Spinner size={16} className='mr-2' />
                                    {t('common.installing')}
                                </>
                            ) : (
                                t('web.skills.library.installSelected', {
                                    count: selectedIds.size
                                })
                            )}
                        </button>
                    </>
                )
            }
        >
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            {results ? (
                <ul className='flex flex-col gap-1.5 py-1'>
                    {results.map((item) => (
                        <li
                            key={item.agentId}
                            className='text-ui flex items-center gap-2'
                        >
                            <span className='text-fg truncate'>
                                {agentById.get(item.agentId)?.name ??
                                    item.agentId}
                            </span>
                            {item.status === 'installed' ? (
                                <span className='text-caption text-muted'>
                                    {t('web.customize.alreadyInstalled')}
                                </span>
                            ) : (
                                <span className='text-caption text-danger'>
                                    {t(
                                        'web.skills.library.installResultFailed'
                                    )}
                                    {item.error ? ` — ${item.error}` : ''}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
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
                        {t('web.skills.library.selectAgents')}
                    </label>
                    <ul className='flex max-h-72 flex-col gap-1 overflow-y-auto'>
                        {agents.map((agent) => {
                            const installed = installedAgentIds.has(agent.id)
                            return (
                                <li key={agent.id}>
                                    <label
                                        className={[
                                            'text-ui flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5',
                                            installed
                                                ? 'text-subtle cursor-default'
                                                : 'hover:bg-surface-hover'
                                        ].join(' ')}
                                    >
                                        <input
                                            type='checkbox'
                                            checked={
                                                installed ||
                                                selectedIds.has(agent.id)
                                            }
                                            disabled={installed || installing}
                                            onChange={() => toggle(agent.id)}
                                        />
                                        <span className='truncate'>
                                            {agent.name}
                                        </span>
                                        <span className='text-caption text-subtle'>
                                            {agent.framework}
                                        </span>
                                        {installed && (
                                            <span className='text-caption text-subtle ml-auto'>
                                                {t(
                                                    'web.skills.library.installedChip'
                                                )}
                                            </span>
                                        )}
                                    </label>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}
        </ProductDialog>
    )
}

export default LibraryInstallDialog
