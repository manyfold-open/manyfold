import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type {
    AutomationDetail,
    AutomationSchedulePreset,
    ChannelSummary
} from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'
import { AutomationsIcon, ExternalLinkIcon } from '@/components/icons'
import { SheenText } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import AgentPicker from './AgentPicker'
import SchedulePicker from './SchedulePicker'
import DeliveryPicker, {
    deliveryIsIncomplete,
    emptyDelivery,
    type DeliveryValue
} from './DeliveryPicker'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import {
    automationTemplates,
    buildPresetRrule,
    defaultTime,
    ensureRrulePrefix,
    scheduleLabel,
    timezone,
    type AutomationTemplate
} from './automationSchedule'
import {
    formatModelLabel,
    modelOptionsForAgent,
    supportsModelOverride
} from './automationUtils'
import { frameworkUsesModelConfig } from '@/lib/agentModelConfig'
import { useAutomationModelConfig } from './useAutomationModelConfig'
import { useI18n } from '@/lib/i18n'

interface CreateAutomationModalProps {
    agents: SdkAgent[]
    agentsLoading: boolean
    template: AutomationTemplate | null
    onClose: () => void
    onCreated: (automation: AutomationDetail) => void
}

const CreateAutomationModal: FC<CreateAutomationModalProps> = ({
    agents,
    agentsLoading,
    template,
    onClose,
    onCreated
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const runnableAgents = useMemo(
        () => agents.filter((agent) => agent.framework !== 'narranexus'),
        [agents]
    )
    const [agentId, setAgentId] = useState(runnableAgents[0]?.id ?? '')
    const [title, setTitle] = useState(template ? t(template.titleKey) : '')
    const [prompt, setPrompt] = useState(template ? t(template.promptKey) : '')
    const [preset, setPreset] = useState<AutomationSchedulePreset>(
        template?.preset ?? 'daily'
    )
    const [time, setTime] = useState(template?.time ?? defaultTime)
    const [weekday, setWeekday] = useState('MO')
    const [rrule, setRrule] = useState(
        buildPresetRrule(
            template?.preset ?? 'daily',
            template?.time ?? defaultTime,
            'MO'
        )
    )
    const [model, setModel] = useState('')
    const [delivery, setDelivery] = useState<DeliveryValue>(emptyDelivery)
    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!agentId && runnableAgents[0]) setAgentId(runnableAgents[0].id)
    }, [agentId, runnableAgents])

    useEffect(() => {
        client.channels
            .list()
            .then(setChannels)
            .catch(() => setChannels([]))
    }, [client])

    const selectedAgent =
        runnableAgents.find((agent) => agent.id === agentId) ?? null
    const deliveryChannel =
        channels.find((channel) => channel.id === delivery.channelId) ?? null
    const {
        view: modelConfigView,
        loading: modelConfigLoading,
        error: modelConfigError
    } = useAutomationModelConfig(selectedAgent?.id, selectedAgent?.framework)
    const usesModelConfig = frameworkUsesModelConfig(selectedAgent?.framework)
    const usesPlatformModelConfig =
        usesModelConfig && modelConfigView?.source !== 'runtime-local'
    const modelOptions = usesPlatformModelConfig
        ? (modelConfigView?.options
              .filter((option) => option.enabled)
              .map((option) => option.value) ?? [])
        : modelOptionsForAgent(selectedAgent)
    const modelConfigBlocked =
        usesPlatformModelConfig &&
        (modelConfigLoading || !modelConfigView?.validation.valid)
    const canSelectModel =
        supportsModelOverride(selectedAgent) &&
        (!usesModelConfig || usesPlatformModelConfig) &&
        !modelConfigBlocked
    const canCreate = Boolean(
        title.trim() &&
        prompt.trim() &&
        selectedAgent &&
        !modelConfigBlocked &&
        !deliveryIsIncomplete(delivery)
    )

    const submit = async (): Promise<void> => {
        if (!selectedAgent) return
        setBusy(true)
        setError(null)
        try {
            const created = await client.automations.create({
                agentId: selectedAgent.id,
                title,
                prompt,
                schedulePreset: preset,
                rrule: ensureRrulePrefix(rrule),
                timezone: timezone(),
                dtstart: new Date().toISOString(),
                model: canSelectModel ? model || null : null,
                deliveryChannelId: delivery.channelId || null,
                deliveryTarget: !delivery.channelId
                    ? null
                    : delivery.destination.startsWith('scope:')
                      ? {
                            kind: 'scope',
                            scopeKey: delivery.destination.slice(
                                'scope:'.length
                            )
                        }
                      : { kind: delivery.kind, id: delivery.id.trim() }
            })
            onCreated(created)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const applyTemplate = (next: AutomationTemplate): void => {
        setTitle(t(next.titleKey))
        setPrompt(t(next.promptKey))
        setPreset(next.preset)
        setTime(next.time)
        setRrule(buildPresetRrule(next.preset, next.time, weekday))
    }

    return (
        <div className='fixed inset-0 z-[100] flex items-center justify-center bg-black/20 px-4 py-8'>
            <div className='workbench-panel shadow-elevated flex max-h-[calc(100vh-4rem)] w-[min(58rem,calc(100vw-2rem))] flex-col overflow-hidden'>
                <div className='min-h-0 flex-1 overflow-auto px-6 py-5'>
                    <input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={t('web.automations.titlePlaceholder')}
                        className='text-h2 placeholder:text-placeholder focus-visible:shadow-focus rounded-xs -mx-1.5 -my-0.5 w-full bg-transparent px-1.5 py-0.5 transition-shadow focus:outline-none'
                    />
                    <textarea
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        placeholder={t('web.automations.promptPlaceholder')}
                        className='text-body text-fg placeholder:text-placeholder focus-visible:shadow-focus rounded-xs -mx-1.5 mt-5 min-h-[13rem] w-full resize-none bg-transparent px-1.5 leading-7 transition-shadow focus:outline-none'
                    />
                    {prompt.trim() === '' && (
                        <div className='mt-1 flex flex-wrap gap-2'>
                            {automationTemplates.map((entry) => (
                                <button
                                    key={entry.id}
                                    type='button'
                                    onClick={() => applyTemplate(entry)}
                                    className='text-ui text-muted bg-soft hover:text-fg hover:bg-surface-hover inline-flex h-7 items-center rounded-full px-3 font-medium transition-colors'
                                >
                                    {t(entry.titleKey)}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {!agentsLoading && runnableAgents.length === 0 && (
                    <div className='px-6 pb-3'>
                        <div className='workbench-panel-subtle flex flex-wrap items-center justify-between gap-3 px-4 py-3'>
                            <span className='text-ui text-muted'>
                                {t('web.automations.needAgent')}
                            </span>
                            <Link
                                to='/agents/new'
                                className='workbench-button-secondary h-8 shrink-0 px-3'
                            >
                                {t('web.automations.needAgentAction')}
                                <ExternalLinkIcon className='ml-1.5 h-3.5 w-3.5' />
                            </Link>
                        </div>
                    </div>
                )}

                {(error || modelConfigError) && (
                    <div className='px-6 pb-3'>
                        <div className='workbench-alert-error'>
                            {error ?? modelConfigError}
                        </div>
                    </div>
                )}

                {selectedAgent && (
                    <div className='text-ui text-muted flex items-start gap-2 px-6 pt-1'>
                        <AutomationsIcon className='text-placeholder mt-1 h-3.5 w-3.5 shrink-0' />
                        <span>
                            {deliveryChannel
                                ? t('web.automations.recapDelivered', {
                                      schedule: scheduleLabel(preset, rrule),
                                      timezone: timezone(),
                                      agent: selectedAgent.name,
                                      destination: `${deliveryChannel.label} · ${deliveryChannel.provider}`
                                  })
                                : t('web.automations.recapWorkbench', {
                                      schedule: scheduleLabel(preset, rrule),
                                      timezone: timezone(),
                                      agent: selectedAgent.name
                                  })}
                        </span>
                    </div>
                )}

                <div className='flex flex-wrap items-center gap-x-2.5 gap-y-3 px-6 pb-5 pt-3'>
                    <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2.5'>
                        <SchedulePicker
                            placement='top'
                            preset={preset}
                            rrule={rrule}
                            time={time}
                            weekday={weekday}
                            onPresetChange={setPreset}
                            onRruleChange={setRrule}
                            onTimeChange={setTime}
                            onWeekdayChange={setWeekday}
                        />
                        <AgentPicker
                            agents={runnableAgents}
                            selectedAgentId={agentId}
                            onSelect={(nextId) => {
                                setAgentId(nextId)
                                setModel('')
                                setDelivery(emptyDelivery)
                            }}
                            placement='top'
                        />
                        {canSelectModel && (
                            <WorkbenchSelect
                                ariaLabel={t('web.automations.model')}
                                className='w-52'
                                tone='soft'
                                value={model}
                                onChange={setModel}
                                options={[
                                    {
                                        value: '',
                                        label: formatModelLabel(
                                            selectedAgent?.model ?? null
                                        )
                                    },
                                    ...modelOptions.map((option) => ({
                                        value: option,
                                        label: formatModelLabel(option)
                                    }))
                                ]}
                            />
                        )}
                        {selectedAgent && (
                            <DeliveryPicker
                                agentId={selectedAgent.id}
                                agentName={selectedAgent.name}
                                channels={channels}
                                value={delivery}
                                onChange={setDelivery}
                            />
                        )}
                        {modelConfigBlocked && (
                            <span className='text-caption text-error'>
                                {modelConfigLoading ? (
                                    <SheenText>
                                        {t('web.automations.loadingModels')}
                                    </SheenText>
                                ) : (
                                    (modelConfigView?.validation.messages[0] ??
                                    t('web.automations.chooseSupportedModel'))
                                )}
                            </span>
                        )}
                    </div>
                    <div className='ml-auto flex shrink-0 items-center gap-2'>
                        <button
                            type='button'
                            onClick={onClose}
                            className='workbench-button-secondary'
                        >
                            {t('web.automations.cancel')}
                        </button>
                        <button
                            type='button'
                            disabled={!canCreate || busy}
                            onClick={() => void submit()}
                            className='workbench-button-primary'
                        >
                            {t('web.automations.create')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default CreateAutomationModal
