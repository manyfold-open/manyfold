import {
    claudeCodeEffortsForModel,
    claudeCodeModelMapAliases,
    isConfigurableFramework,
    normalizeClaudeCodeEffortForModel,
    resolveClaudeCodeProviderModel
} from '@manyfold/shared'
import type {
    AgentModelConfig,
    AgentModelConfigView,
    ClaudeCodeEffort,
    ClaudeCodeModelMap,
    FrameworkCatalogView
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { Badge, Button, Card, Heading } from '@/ui'

interface Props {
    agentId: string
    isAdmin: boolean
}

export const AgentModelConfigPanel: FC<Props> = ({
    agentId,
    isAdmin
}): ReactNode => {
    const client = useApiClient()
    const agentsApi = isAdmin ? client.admin.agents : client.agents
    const [view, setView] = useState<AgentModelConfigView | null>(null)
    const [catalog, setCatalog] = useState<FrameworkCatalogView | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback((): void => {
        setError(null)
        agentsApi
            .getModelConfig(agentId)
            .then((next) => {
                setView(next)
                if (isConfigurableFramework(next.framework))
                    return client.frameworkCatalog.get(next.framework)
                setCatalog(null)
                return null
            })
            .then((cat) => {
                if (cat) setCatalog(cat)
            })
            .catch((e: Error) => setError(e.message))
    }, [agentsApi, client, agentId])

    useEffect(refresh, [refresh])

    const onTestProvider = async (): Promise<void> => {
        setBusy(true)
        try {
            await agentsApi.refreshModelConfigModels(agentId, {
                source: 'platform'
            })
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const onSave = async (next: AgentModelConfig): Promise<void> => {
        setBusy(true)
        try {
            await agentsApi.updateModelConfig(agentId, {
                modelConfigSource: 'platform',
                model: next.model,
                modelConfig: next
            })
            refresh()
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(false)
        }
    }

    if (error) {
        return (
            <Card
                elevation='flat'
                className='border-accent-ruby/30 bg-accent-ruby/5 p-2'
            >
                <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                    {error}
                </pre>
                <div className='mt-2'>
                    <Button variant='ghost' onClick={refresh}>
                        Retry
                    </Button>
                </div>
            </Card>
        )
    }
    if (!view) return <p className='text-caption text-body'>Loading…</p>
    if (!isConfigurableFramework(view.framework))
        return (
            <p className='text-caption text-body'>
                Model configuration is not supported for this framework.
            </p>
        )
    return (
        <div className='space-y-3'>
            <Card elevation='flat' className='p-3'>
                <Heading level={3} className='mb-2'>
                    Provider
                </Heading>
                <div className='text-caption space-y-1'>
                    <div>
                        <span className='text-label'>Provider:</span>{' '}
                        {view.provider ?? '—'}
                    </div>
                    <div>
                        <span className='text-label'>Base URL:</span>{' '}
                        {view.providerBaseUrl ?? '—'}
                    </div>
                    <div>
                        <span className='text-label'>Status:</span>{' '}
                        <Badge
                            tone={
                                view.providerModelsStatus === 'ready'
                                    ? 'success'
                                    : view.providerModelsStatus ===
                                        'needs_refresh'
                                      ? 'warning'
                                      : 'neutral'
                            }
                        >
                            {view.providerModelsStatus}
                        </Badge>
                    </div>
                    <div>
                        <span className='text-label'>Tested models:</span>{' '}
                        {view.providerModels.length}
                    </div>
                </div>
                <div className='mt-2'>
                    <Button
                        variant='ghost'
                        onClick={onTestProvider}
                        disabled={busy}
                    >
                        Test provider
                    </Button>
                </div>
            </Card>

            <Card elevation='flat' className='p-3'>
                <Heading level={3} className='mb-2'>
                    Model configuration
                </Heading>
                {view.framework === 'claude-code' && (
                    <ClaudeCodeForm
                        view={view}
                        catalog={catalog}
                        busy={busy}
                        onSave={onSave}
                    />
                )}
                {view.framework === 'codex' && (
                    <CodexForm
                        view={view}
                        catalog={catalog}
                        busy={busy}
                        onSave={onSave}
                    />
                )}
                {view.framework === 'gemini-cli' && (
                    <GeminiForm
                        view={view}
                        catalog={catalog}
                        busy={busy}
                        onSave={onSave}
                    />
                )}
                {view.validation.messages.length > 0 && (
                    <ul className='mt-3 list-disc pl-5 text-caption text-accent-ruby'>
                        {view.validation.messages.map((m) => (
                            <li key={m}>{m}</li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    )
}

interface FormProps {
    view: AgentModelConfigView
    catalog: FrameworkCatalogView | null
    busy: boolean
    onSave: (config: AgentModelConfig) => Promise<void>
}

const ClaudeCodeForm: FC<FormProps> = ({
    view,
    catalog,
    busy,
    onSave
}): ReactNode => {
    const cfg = view.config?.framework === 'claude-code' ? view.config : null
    const [model, setModel] = useState<string>(cfg?.model ?? '')
    const [effort, setEffort] = useState<string>(cfg?.effort ?? '')
    const [modelMap, setModelMap] = useState<ClaudeCodeModelMap>(
        cfg?.modelMap ?? {}
    )
    const selectedProviderModel = resolveClaudeCodeProviderModel(
        model || null,
        modelMap
    )
    const effortValues = claudeCodeEffortsForModel(selectedProviderModel)
    const normalizedEffort =
        normalizeClaudeCodeEffortForModel(
            (effort || null) as ClaudeCodeEffort | null,
            selectedProviderModel
        ) ?? ''
    const effortLabels = new Map(
        (catalog?.enums.effort ?? []).map((e) => [e.value, e.displayName])
    )
    useEffect(() => {
        if (effort !== normalizedEffort) setEffort(normalizedEffort)
    }, [effort, normalizedEffort])
    return (
        <div className='space-y-2'>
            <FieldSelect
                id='claude-model'
                label='Selected model'
                value={model}
                onChange={setModel}
                options={view.options.map((o) => ({
                    value: o.value,
                    label: o.label,
                    disabled: !o.enabled
                }))}
            />
            {effortValues.length > 0 && (
                <FieldSelect
                    id='claude-effort'
                    label='Reasoning effort'
                    value={normalizedEffort}
                    onChange={setEffort}
                    options={effortValues.map((value) => ({
                        value,
                        label: effortLabels.get(value) ?? titleCase(value)
                    }))}
                />
            )}
            <div className='border-t border-border pt-2'>
                <p className='text-label text-caption-sm mb-1'>Model map</p>
                {claudeCodeModelMapAliases.map((alias) => (
                    <FieldSelect
                        key={alias}
                        id={`claude-map-${alias}`}
                        label={alias}
                        value={modelMap[alias] ?? ''}
                        onChange={(v) =>
                            setModelMap((m) => ({ ...m, [alias]: v || undefined }))
                        }
                        options={[
                            { value: '', label: '— not mapped —' },
                            ...view.providerModels.map((pm) => ({
                                value: pm,
                                label: pm
                            }))
                        ]}
                    />
                ))}
            </div>
            <Button
                variant='primary'
                disabled={busy}
                onClick={() =>
                    onSave({
                        framework: 'claude-code',
                        model: model || null,
                        effort:
                            (normalizedEffort as
                                | 'low'
                                | 'medium'
                                | 'high'
                                | 'xhigh'
                                | 'max') || null,
                        modelMap
                    })
                }
            >
                Save
            </Button>
        </div>
    )
}

const CodexForm: FC<FormProps> = ({
    view,
    catalog,
    busy,
    onSave
}): ReactNode => {
    const cfg = view.config?.framework === 'codex' ? view.config : null
    const [model, setModel] = useState<string>(cfg?.model ?? '')
    const [speed, setSpeed] = useState<string>(cfg?.speed ?? 'standard')
    const [intelligence, setIntelligence] = useState<string>(
        cfg?.intelligence ?? 'medium'
    )
    const speeds = catalog?.enums.speed ?? []
    const intel = catalog?.enums.intelligence ?? []
    return (
        <div className='space-y-2'>
            <FieldSelect
                id='codex-model'
                label='Selected model'
                value={model}
                onChange={setModel}
                options={view.options.map((o) => ({
                    value: o.value,
                    label:
                        o.label +
                        (o.supportsFast ? ' · fast supported' : ''),
                    disabled: !o.enabled
                }))}
            />
            <FieldSelect
                id='codex-speed'
                label='Speed'
                value={speed}
                onChange={setSpeed}
                options={speeds.map((s) => ({
                    value: s.value,
                    label: s.displayName + (s.isDefault ? ' (default)' : '')
                }))}
            />
            <FieldSelect
                id='codex-intelligence'
                label='Reasoning effort'
                value={intelligence}
                onChange={setIntelligence}
                options={intel.map((s) => ({
                    value: s.value,
                    label: s.displayName + (s.isDefault ? ' (default)' : '')
                }))}
            />
            <Button
                variant='primary'
                disabled={busy}
                onClick={() =>
                    onSave({
                        framework: 'codex',
                        model: model || null,
                        speed: speed as 'standard' | 'fast',
                        intelligence: intelligence as
                            | 'low'
                            | 'medium'
                            | 'high'
                            | 'xhigh'
                    })
                }
            >
                Save
            </Button>
        </div>
    )
}

const GeminiForm: FC<FormProps> = ({
    view,
    busy,
    onSave
}): ReactNode => {
    const cfg = view.config?.framework === 'gemini-cli' ? view.config : null
    const [model, setModel] = useState<string>(cfg?.model ?? '')
    return (
        <div className='space-y-2'>
            <FieldSelect
                id='gemini-model'
                label='Selected model'
                value={model}
                onChange={setModel}
                options={[
                    { value: '', label: '— catalog default —' },
                    ...view.options.map((o) => ({
                        value: o.value,
                        label: o.label,
                        disabled: !o.enabled
                    }))
                ]}
            />
            <Button
                variant='primary'
                disabled={busy}
                onClick={() =>
                    onSave({
                        framework: 'gemini-cli',
                        model: model || null
                    })
                }
            >
                Save
            </Button>
        </div>
    )
}

interface FieldSelectProps {
    id: string
    label: string
    value: string
    onChange: (next: string) => void
    options: { value: string; label: string; disabled?: boolean }[]
}

const titleCase = (value: string): string =>
    value.slice(0, 1).toUpperCase() + value.slice(1)

const FieldSelect: FC<FieldSelectProps> = ({
    id,
    label,
    value,
    onChange,
    options
}): ReactNode => (
    <div>
        <label
            htmlFor={id}
            className='text-caption text-label mb-1 block font-normal'
        >
            {label}
        </label>
        <select
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className='block h-8 w-full rounded border border-border bg-white px-2 text-caption'
        >
            {options.map((o) => (
                <option
                    key={o.value || '__empty__'}
                    value={o.value}
                    disabled={o.disabled}
                >
                    {o.label}
                </option>
            ))}
        </select>
    </div>
)
