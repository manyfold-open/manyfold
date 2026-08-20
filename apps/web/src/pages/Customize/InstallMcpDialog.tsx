import {
    frameworkMcpSupport,
    mcpConfigFromExtras
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import ProductDialog from '@/components/ProductDialog'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { useApiClient } from '@/lib/apiClient'
import { SheenText, Spinner } from '@/components/Loading'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import {
    mcpServerNames,
    mergeMcpServerIntoText,
    type McpInstallableEntry
} from '@/lib/mcpSnippet'
import AgentPicker from '@/pages/Automations/AgentPicker'

interface Props {
    entry: McpInstallableEntry
    onClose: () => void
}

const InstallMcpDialog: FC<Props> = ({ entry, onClose }): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [selectedAgentId, setSelectedAgentId] = useState('')
    const [scopeId, setScopeId] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [installedTo, setInstalledTo] = useState<SdkAgent | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        client.agents
            .list()
            .then((allAgents) => {
                if (cancelled) return
                setAgents(
                    allAgents.filter(
                        (agent) =>
                            (agent.runtime === 'sprites' ||
                                agent.runtime === 'daemon') &&
                            frameworkMcpSupport(agent.framework)
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
    }, [client])

    const selectedAgent = useMemo(
        () => agents.find((agent) => agent.id === selectedAgentId) ?? null,
        [agents, selectedAgentId]
    )
    const support = selectedAgent
        ? frameworkMcpSupport(selectedAgent.framework)
        : undefined
    const scopes = support?.scopes ?? []
    const activeScopeId = scopes.some((scope) => scope.id === scopeId)
        ? scopeId
        : (scopes[0]?.id ?? '')

    const alreadyConfigured = useMemo(() => {
        if (!selectedAgent || !support || !activeScopeId) return false
        const text =
            mcpConfigFromExtras(selectedAgent.extras)[activeScopeId] ?? ''
        return mcpServerNames(support.format, text).includes(entry.id)
    }, [selectedAgent, support, activeScopeId, entry.id])

    const install = async (): Promise<void> => {
        if (
            !selectedAgent ||
            !support ||
            !activeScopeId ||
            alreadyConfigured ||
            saving
        )
            return
        setSaving(true)
        setError(null)
        try {
            // extras.mcp updates replace the whole per-scope map, so merge into
            // a freshly fetched copy to avoid clobbering concurrent edits.
            const fresh = await client.agents.get(selectedAgent.id)
            const map = mcpConfigFromExtras(fresh.extras)
            const current = map[activeScopeId] ?? ''
            if (mcpServerNames(support.format, current).includes(entry.id)) {
                setError(t('web.customize.alreadyConfigured'))
                return
            }
            let merged: string
            try {
                merged = mergeMcpServerIntoText(
                    support.format,
                    selectedAgent.framework,
                    current,
                    entry
                )
            } catch {
                setError(t('web.customize.invalidExistingConfig'))
                return
            }
            await client.agents.update(selectedAgent.id, {
                mcp: { ...map, [activeScopeId]: merged }
            })
            setInstalledTo(selectedAgent)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.customize.installToAgent')}
            description={entry.name}
            onClose={onClose}
            closeDisabled={saving}
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
                            disabled={saving}
                            className='workbench-button-secondary'
                        >
                            {t('common.cancel')}
                        </button>
                        <button
                            type='button'
                            onClick={() => void install()}
                            disabled={
                                !selectedAgent ||
                                !activeScopeId ||
                                alreadyConfigured ||
                                saving
                            }
                            className='workbench-button-primary'
                        >
                            {saving ? (
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
                        to={agentSettingsPath(installedTo.id, 'mcp')}
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
                        {t('web.customize.noMcpAgents')}
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
                <div className='space-y-4 py-1'>
                    <div>
                        <label className='text-caption text-muted mb-2 block'>
                            {t('web.customize.selectAgent')}
                        </label>
                        <AgentPicker
                            agents={agents}
                            selectedAgentId={selectedAgentId}
                            onSelect={setSelectedAgentId}
                            placeholder={t('web.customize.selectAgent')}
                            disabled={saving}
                        />
                    </div>
                    {selectedAgent && scopes.length > 1 && (
                        <div>
                            <label className='text-caption text-muted mb-2 block'>
                                {t('web.customize.selectScope')}
                            </label>
                            <WorkbenchSelect
                                ariaLabel={t('web.customize.selectScope')}
                                value={activeScopeId}
                                onChange={setScopeId}
                                disabled={saving}
                                options={scopes.map((scope) => ({
                                    value: scope.id,
                                    label: `${scope.label} · ${scope.path}`
                                }))}
                            />
                        </div>
                    )}
                    {alreadyConfigured && (
                        <p className='text-caption text-muted'>
                            {t('web.customize.alreadyConfigured')}
                        </p>
                    )}
                </div>
            )}
        </ProductDialog>
    )
}

export default InstallMcpDialog
