import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type {
    AutomationDetail as AutomationDetailDto,
    AutomationRunSummary,
    AutomationSchedulePreset,
    AutomationStatus,
    ChannelScopeSummary,
    ChannelSummary
} from '@manyfold/shared'
import { AGENT_SEND_PROVIDERS } from '@manyfold/shared'
import {
    buildPresetRrule,
    defaultTime,
    ensureRrulePrefix,
    formatExactDateTime,
    formatNextRun,
    formatRelativePast,
    formatRunDuration,
    parseTimeFromRrule,
    parseWeekdayFromRrule,
    timezone
} from './automationSchedule'
import {
    CheckIcon,
    CloseIcon,
    InfoIcon,
    PauseIcon,
    PlayIcon,
    TrashIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { StatusTag } from '@/components/Tag'
import { Ghost, SheenText } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { buildQuotaConflictRequest } from '@/lib/quotaConflict'
import { useAppShellContext } from '@/components/AppShell'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import SchedulePicker from './SchedulePicker'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { scopeOptionLabel } from './deliveryLabels'
import {
    formatModelLabel,
    modelOptionsForAgent,
    supportsModelOverride
} from './automationUtils'
import { frameworkUsesModelConfig } from '@/lib/agentModelConfig'
import { useAutomationModelConfig } from './useAutomationModelConfig'
import { useI18n } from '@/lib/i18n'

const RUNS_COLLAPSED = 4

const AutomationDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const navigate = useNavigate()
    const { t } = useI18n()
    const { agents, refreshSessionsForAgent, requestQuotaConflict } =
        useAppShellContext()
    const [detail, setDetail] = useState<AutomationDetailDto | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [title, setTitle] = useState('')
    const [prompt, setPrompt] = useState('')
    const [agentId, setAgentId] = useState('')
    const [status, setStatus] = useState<AutomationStatus>('active')
    const [preset, setPreset] = useState<AutomationSchedulePreset>('daily')
    const [time, setTime] = useState(defaultTime)
    const [weekday, setWeekday] = useState('MO')
    const [rrule, setRrule] = useState(
        buildPresetRrule('daily', defaultTime, 'MO')
    )
    const [model, setModel] = useState('')
    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const [deliveryChannelId, setDeliveryChannelId] = useState('')
    // '' = nothing picked, 'scope:<scopeKey>' = existing conversation,
    // 'custom' = explicit chat/user id (sendDirect providers only).
    const [deliveryDestination, setDeliveryDestination] = useState('')
    const [deliveryKind, setDeliveryKind] = useState<'chat' | 'user'>('chat')
    const [deliveryId, setDeliveryId] = useState('')
    const [scopes, setScopes] = useState<ChannelScopeSummary[]>([])
    const [scopesLoading, setScopesLoading] = useState(false)
    const [runsExpanded, setRunsExpanded] = useState(false)
    const dirtyRef = useRef(false)

    const applyDeliveryState = (next: AutomationDetailDto): void => {
        setDeliveryChannelId(next.deliveryChannelId ?? '')
        const target = next.deliveryTarget
        if (target?.kind === 'scope') {
            setDeliveryDestination(`scope:${target.scopeKey}`)
            setDeliveryKind('chat')
            setDeliveryId('')
        } else {
            setDeliveryDestination(target ? 'custom' : '')
            setDeliveryKind(target?.kind ?? 'chat')
            setDeliveryId(target?.id ?? '')
        }
    }

    const refresh = async (): Promise<void> => {
        if (!id) return
        setLoading(true)
        try {
            const next = await client.automations.get(id)
            setDetail(next)
            if (!dirtyRef.current) {
                setTitle(next.title)
                setPrompt(next.prompt)
                setAgentId(next.agentId)
                setStatus(next.status)
                setPreset(next.schedulePreset)
                setRrule(next.rrule)
                setTime(parseTimeFromRrule(next.rrule))
                setWeekday(parseWeekdayFromRrule(next.rrule))
                setModel(next.model ?? '')
                applyDeliveryState(next)
            }
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client, id])

    useEffect(() => {
        client.channels
            .list()
            .then(setChannels)
            .catch(() => setChannels([]))
    }, [client])

    useEffect(() => {
        if (!deliveryChannelId) {
            setScopes([])
            setScopesLoading(false)
            return
        }
        let cancelled = false
        setScopesLoading(true)
        client.channels
            .listScopes(deliveryChannelId)
            .then((next) => {
                if (!cancelled) setScopes(next)
            })
            .catch(() => {
                if (!cancelled) setScopes([])
            })
            .finally(() => {
                if (!cancelled) setScopesLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [client, deliveryChannelId])

    useEffect(() => {
        if (!detail?.runs.some((run) => run.status === 'running')) return
        const interval = window.setInterval(() => {
            void refresh()
        }, 3000)
        return () => window.clearInterval(interval)
    }, [detail])

    const runnableAgents = useMemo(
        () => agents.filter((agent) => agent.framework !== 'narranexus'),
        [agents]
    )
    // The rail loads agents asynchronously; until it lands, the bound agent is
    // the only option we can name, and an empty select would read as "unset".
    const agentOptions = useMemo(() => {
        const options = runnableAgents.map((agent) => ({
            value: agent.id,
            label: agent.name
        }))
        if (
            detail &&
            !options.some((option) => option.value === detail.agentId)
        )
            options.unshift({
                value: detail.agentId,
                label: detail.agent.name
            })
        return options
    }, [detail, runnableAgents])
    const selectedAgent =
        runnableAgents.find((agent) => agent.id === agentId) ??
        (detail
            ? {
                  id: detail.agent.id,
                  name: detail.agent.name,
                  framework: detail.agent.framework,
                  status: detail.agent.status,
                  model: detail.agent.model
              }
            : null)
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
        supportsModelOverride(selectedAgent?.framework) &&
        (!usesModelConfig || usesPlatformModelConfig) &&
        !modelConfigBlocked
    // Every active channel bound to the agent can receive scope delivery
    // (sendText is universal); custom chat/user ids stay gated to providers
    // implementing sendDirect.
    const deliverableChannels = useMemo(
        () =>
            channels.filter(
                (channel) =>
                    channel.agentId === agentId && channel.status === 'active'
            ),
        [channels, agentId]
    )
    const deliveryChannel =
        channels.find((channel) => channel.id === deliveryChannelId) ?? null
    const supportsCustomIds =
        deliveryChannel !== null &&
        AGENT_SEND_PROVIDERS.includes(deliveryChannel.provider)
    const savedScopeKey =
        detail !== null &&
        detail.deliveryChannelId === deliveryChannelId &&
        detail.deliveryTarget?.kind === 'scope'
            ? detail.deliveryTarget.scopeKey
            : null
    const destinationOptions = useMemo(() => {
        const options = scopes.map((scope) => ({
            value: `scope:${scope.scopeKey}`,
            label:
                scopeOptionLabel(deliveryChannel?.provider ?? '', scope, t) +
                (scope.activeSession
                    ? ''
                    : ` — ${t('web.automations.inactive')}`),
            disabled:
                !scope.activeSession &&
                `scope:${scope.scopeKey}` !== deliveryDestination
        }))
        if (
            savedScopeKey &&
            !scopes.some((scope) => scope.scopeKey === savedScopeKey)
        )
            options.push({
                value: `scope:${savedScopeKey}`,
                label: t('web.automations.savedConversationInactive'),
                disabled: false
            })
        if (supportsCustomIds)
            options.push({
                value: 'custom',
                label: t('web.automations.customChatUserId'),
                disabled: false
            })
        return options
    }, [
        scopes,
        deliveryChannel,
        deliveryDestination,
        savedScopeKey,
        supportsCustomIds,
        t
    ])
    const deliveryIncomplete =
        deliveryChannelId !== '' &&
        (deliveryDestination === '' ||
            (deliveryDestination === 'custom' && deliveryId.trim() === ''))
    const detailDestination = !detail?.deliveryTarget
        ? ''
        : detail.deliveryTarget.kind === 'scope'
          ? `scope:${detail.deliveryTarget.scopeKey}`
          : 'custom'
    const detailCustomKind =
        detail?.deliveryTarget && detail.deliveryTarget.kind !== 'scope'
            ? detail.deliveryTarget.kind
            : 'chat'
    const detailCustomId =
        detail?.deliveryTarget && detail.deliveryTarget.kind !== 'scope'
            ? detail.deliveryTarget.id
            : ''
    // Pause/resume and Run now are actions that commit immediately; every
    // field below is configuration that collects into one explicit save, so
    // status deliberately stays out of this comparison.
    const changed = useMemo(() => {
        if (!detail) return [] as string[]
        const fields: string[] = []
        if (title !== detail.title) fields.push(t('web.automations.fieldTitle'))
        if (prompt !== detail.prompt)
            fields.push(t('web.automations.fieldPrompt'))
        if (agentId !== detail.agentId) fields.push(t('web.automations.agent'))
        if (preset !== detail.schedulePreset || rrule !== detail.rrule)
            fields.push(t('web.automations.schedule'))
        if ((model || null) !== detail.model)
            fields.push(t('web.automations.model'))
        if (
            (deliveryChannelId || null) !== detail.deliveryChannelId ||
            deliveryDestination !== detailDestination ||
            (deliveryDestination === 'custom' &&
                (deliveryKind !== detailCustomKind ||
                    deliveryId.trim() !== detailCustomId))
        )
            fields.push(t('web.automations.deliverResults'))
        return fields
    }, [
        agentId,
        detail,
        detailCustomId,
        detailCustomKind,
        detailDestination,
        deliveryChannelId,
        deliveryDestination,
        deliveryId,
        deliveryKind,
        model,
        preset,
        prompt,
        rrule,
        t,
        title
    ])
    const dirty = changed.length > 0

    useEffect(() => {
        dirtyRef.current = dirty
    })

    const save = async (): Promise<void> => {
        if (!id) return
        setBusy(true)
        setError(null)
        try {
            const updated = await client.automations.update(id, {
                agentId,
                title,
                prompt,
                status,
                schedulePreset: preset,
                rrule: ensureRrulePrefix(rrule),
                timezone: detail?.timezone ?? timezone(),
                dtstart: detail?.dtstart ?? new Date().toISOString(),
                model: canSelectModel ? model || null : null,
                deliveryChannelId: deliveryChannelId || null,
                deliveryTarget: !deliveryChannelId
                    ? null
                    : deliveryDestination.startsWith('scope:')
                      ? {
                            kind: 'scope',
                            scopeKey: deliveryDestination.slice('scope:'.length)
                        }
                      : { kind: deliveryKind, id: deliveryId.trim() }
            })
            setDetail(updated)
            setTitle(updated.title)
            setPrompt(updated.prompt)
            setAgentId(updated.agentId)
            setStatus(updated.status)
            setPreset(updated.schedulePreset)
            setRrule(updated.rrule)
            setModel(updated.model ?? '')
            applyDeliveryState(updated)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const discard = (): void => {
        if (!detail) return
        setTitle(detail.title)
        setPrompt(detail.prompt)
        setAgentId(detail.agentId)
        setPreset(detail.schedulePreset)
        setRrule(detail.rrule)
        setTime(parseTimeFromRrule(detail.rrule))
        setWeekday(parseWeekdayFromRrule(detail.rrule))
        setModel(detail.model ?? '')
        applyDeliveryState(detail)
        setError(null)
    }

    const runNow = async (): Promise<void> => {
        if (!id || !detail) return
        setBusy(true)
        setError(null)
        try {
            await client.automations.run(id)
            await Promise.all([
                refresh(),
                refreshSessionsForAgent(detail.agentId)
            ])
        } catch (err) {
            const agent = agents.find((a) => a.id === detail.agentId)
            const conflict = buildQuotaConflictRequest({
                err,
                newAgent: {
                    id: detail.agentId,
                    name: agent?.name ?? detail.title
                },
                candidates: agents,
                retry: async () => {
                    await runNow()
                }
            })
            if (conflict) {
                requestQuotaConflict(conflict)
                return
            }
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const togglePaused = async (): Promise<void> => {
        setStatus((prev) => (prev === 'active' ? 'paused' : 'active'))
        if (!id || !detail) return
        setBusy(true)
        try {
            const updated = await client.automations.update(id, {
                status: detail.status === 'active' ? 'paused' : 'active'
            })
            setDetail(updated)
            setStatus(updated.status)
        } catch (err) {
            setError(apiErrorMessage(err))
            setStatus(detail.status)
        } finally {
            setBusy(false)
        }
    }

    const remove = async (): Promise<void> => {
        if (!id) return
        if (
            !(await confirm({
                title: t('web.automations.deleteTitle'),
                description: t('web.automations.deleteConfirm', {
                    title: detail?.title ?? t('web.automations.title')
                }),
                confirmLabel: t('web.automations.deleteAction'),
                tone: 'danger'
            }))
        )
            return
        setBusy(true)
        try {
            await client.automations.delete(id)
            navigate('/automations')
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    if (loading && !detail)
        return (
            <div className='workbench-page-wide' aria-busy='true'>
                <Ghost variant='title' className='w-56' />
                <Ghost variant='cap' className='mt-3 w-80 max-w-full' />
                <div className='workbench-panel mt-7 space-y-3 px-5 py-5'>
                    <Ghost variant='line' className='w-1/4' />
                    <Ghost variant='cap' className='w-3/5' />
                    <Ghost variant='cap' className='w-2/5' />
                    <Ghost variant='cap' className='w-1/2' />
                </div>
            </div>
        )

    if (!detail)
        return (
            <div className='workbench-page-wide'>
                {error && <div className='workbench-alert-error'>{error}</div>}
            </div>
        )

    const visibleRuns = runsExpanded
        ? detail.runs
        : detail.runs.slice(0, RUNS_COLLAPSED)

    return (
        <div className='workbench-page-wide'>
            {dirty && (
                <div className='sticky top-0 z-20 -mx-1 mb-5 px-1 pt-1'>
                    <div className='workbench-panel shadow-elevated flex flex-wrap items-center gap-3 px-4 py-2.5'>
                        <span
                            className='bg-warning h-2 w-2 shrink-0 rounded-full'
                            aria-hidden='true'
                        />
                        <span className='text-ui text-fg font-medium'>
                            {t('web.automations.unsavedChanges')}
                        </span>
                        <span className='text-ui text-placeholder min-w-0 truncate'>
                            {changed.join(', ')}
                        </span>
                        <div className='ml-auto flex shrink-0 items-center gap-2'>
                            <button
                                type='button'
                                onClick={discard}
                                disabled={busy}
                                className='workbench-button-secondary h-8 px-3'
                            >
                                {t('web.automations.discard')}
                            </button>
                            <button
                                type='button'
                                onClick={() => void save()}
                                disabled={
                                    busy ||
                                    modelConfigBlocked ||
                                    deliveryIncomplete
                                }
                                className='workbench-button-primary h-8 px-3'
                            >
                                {t('web.automations.saveChanges')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className='mb-6 flex flex-wrap items-center justify-between gap-3'>
                <div className='text-ui text-muted flex items-center gap-2'>
                    <Link to='/automations' className='hover:text-fg'>
                        {t('web.automations.title')}
                    </Link>
                    <span>/</span>
                    <span className='text-fg'>{detail.title}</span>
                </div>
                <div className='flex items-center gap-2'>
                    <button
                        type='button'
                        onClick={() => void togglePaused()}
                        disabled={busy}
                        className='workbench-button-secondary'
                    >
                        {status === 'active' ? (
                            <PauseIcon className='mr-2 h-4 w-4' />
                        ) : (
                            <PlayIcon className='mr-2 h-4 w-4' />
                        )}
                        {status === 'active'
                            ? t('web.automations.pause')
                            : t('web.automations.resume')}
                    </button>
                    <ShortcutTooltip label={t('web.automations.deleteTitle')}>
                        <button
                            type='button'
                            onClick={() => void remove()}
                            disabled={busy}
                            className='workbench-button-secondary h-9 w-9 px-0'
                            aria-label={t('web.automations.deleteTitle')}
                        >
                            <TrashIcon className='h-4 w-4' />
                        </button>
                    </ShortcutTooltip>
                    <button
                        type='button'
                        onClick={() => void runNow()}
                        disabled={busy}
                        className='workbench-button-primary'
                    >
                        <PlayIcon className='mr-2 h-4 w-4' />
                        {t('web.automations.runNow')}
                    </button>
                </div>
            </div>

            {(error || modelConfigError) && (
                <div className='workbench-alert-error mb-5'>
                    {error ?? modelConfigError}
                </div>
            )}

            <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className='text-h1 text-fg focus-visible:shadow-focus rounded-xs -mx-1.5 -my-0.5 w-full bg-transparent px-1.5 py-0.5 font-sans transition-shadow focus:outline-none'
            />

            <div className='text-ui text-muted mb-7 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 tabular-nums'>
                <StatusTag
                    tone={status === 'active' ? 'success' : 'idle'}
                    label={
                        status === 'active'
                            ? t('web.automations.active')
                            : t('web.automations.paused')
                    }
                />
                {status === 'active' && (
                    <>
                        <span>
                            {t('web.automations.nextRun')}{' '}
                            <ShortcutTooltip
                                label={
                                    detail.nextRunAt
                                        ? formatExactDateTime(
                                              detail.nextRunAt,
                                              detail.timezone
                                          )
                                        : undefined
                                }
                            >
                                <span className='text-fg font-medium'>
                                    {formatNextRun(
                                        detail.nextRunAt,
                                        detail.timezone
                                    )}
                                </span>
                            </ShortcutTooltip>
                        </span>
                        <span className='text-placeholder'>
                            {detail.timezone}
                        </span>
                    </>
                )}
                {detail.lastRunAt && (
                    <>
                        <span
                            className='bg-divider hidden h-3.5 w-px sm:block'
                            aria-hidden='true'
                        />
                        <span className='flex items-center gap-1.5'>
                            {t('web.automations.lastRan')}
                            <RunStatusMark status={detail.lastRunStatus} />
                            {detail.runs[0]?.chatSessionId ? (
                                <Link
                                    to={`/agents/${detail.agentId}/chat?sessionId=${detail.runs[0].chatSessionId}`}
                                    className='text-fg font-medium hover:underline'
                                >
                                    {formatRelativePast(detail.lastRunAt)}
                                </Link>
                            ) : (
                                <span className='text-fg font-medium'>
                                    {formatRelativePast(detail.lastRunAt)}
                                </span>
                            )}
                        </span>
                    </>
                )}
            </div>

            <div className='grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]'>
                <main className='min-w-0'>
                    <div className='workbench-panel px-5 py-5'>
                        <textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            className='text-body text-fg focus-visible:shadow-focus rounded-xs -mx-1.5 min-h-[22rem] w-full resize-none bg-transparent px-1.5 leading-7 transition-shadow focus:outline-none'
                        />
                    </div>
                </main>

                <aside className='flex flex-col gap-6'>
                    <section>
                        <div className='text-ui text-subtle mb-2.5 font-medium'>
                            {t('web.automations.details')}
                        </div>
                        <div className='settings-card px-4 py-3.5'>
                            <DetailRow label={t('web.automations.agent')}>
                                <WorkbenchSelect
                                    size='sm'
                                    className='ml-auto w-44 max-w-full text-left'
                                    ariaLabel={t('web.automations.agent')}
                                    value={agentId}
                                    onChange={(next) => {
                                        setAgentId(next)
                                        setModel('')
                                    }}
                                    options={agentOptions}
                                />
                            </DetailRow>
                            <DetailRow label={t('web.automations.repeats')}>
                                <SchedulePicker
                                    align='end'
                                    variant='select'
                                    className='ml-auto w-44 max-w-full'
                                    preset={preset}
                                    rrule={rrule}
                                    time={time}
                                    weekday={weekday}
                                    onPresetChange={setPreset}
                                    onRruleChange={setRrule}
                                    onTimeChange={setTime}
                                    onWeekdayChange={setWeekday}
                                />
                            </DetailRow>
                            <DetailRow
                                label={t('web.automations.model')}
                                last={true}
                            >
                                {canSelectModel ? (
                                    <WorkbenchSelect
                                        size='sm'
                                        className='ml-auto w-44 max-w-full text-left'
                                        ariaLabel={t('web.automations.model')}
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
                                ) : modelConfigBlocked ? (
                                    <span className='text-error'>
                                        {modelConfigLoading ? (
                                            <SheenText>
                                                {t(
                                                    'web.automations.loadingModels'
                                                )}
                                            </SheenText>
                                        ) : (
                                            (modelConfigView?.validation
                                                .messages[0] ??
                                            t(
                                                'web.automations.chooseSupportedModel'
                                            ))
                                        )}
                                    </span>
                                ) : (
                                    formatModelLabel(
                                        selectedAgent?.model ?? null
                                    )
                                )}
                            </DetailRow>
                        </div>
                    </section>

                    <section>
                        <div className='text-ui text-subtle mb-2.5 font-medium'>
                            {t('web.automations.deliverResults')}
                        </div>
                        <div className='settings-card px-4 py-3.5'>
                            <DetailRow
                                label={t('web.automations.channel')}
                                last={deliveryChannelId === ''}
                            >
                                <WorkbenchSelect
                                    size='sm'
                                    className='ml-auto w-44 max-w-full text-left'
                                    ariaLabel={t('web.automations.channel')}
                                    value={deliveryChannelId}
                                    onChange={(next) => {
                                        setDeliveryChannelId(next)
                                        setDeliveryDestination('')
                                        setDeliveryKind('chat')
                                        setDeliveryId('')
                                    }}
                                    options={[
                                        {
                                            value: '',
                                            label: t(
                                                'web.automations.workbenchOnly'
                                            )
                                        },
                                        ...deliverableChannels.map(
                                            (channel) => ({
                                                value: channel.id,
                                                label: `${channel.label} (${channel.provider})`
                                            })
                                        )
                                    ]}
                                />
                            </DetailRow>
                            {deliveryChannelId !== '' && (
                                <>
                                    <DetailRow
                                        label={t('web.automations.destination')}
                                        last={deliveryDestination !== 'custom'}
                                    >
                                        <WorkbenchSelect
                                            size='sm'
                                            className='ml-auto w-44 max-w-full text-left'
                                            ariaLabel={t(
                                                'web.automations.destination'
                                            )}
                                            value={deliveryDestination}
                                            onChange={setDeliveryDestination}
                                            placeholder={
                                                scopesLoading
                                                    ? t(
                                                          'web.automations.loadingConversations'
                                                      )
                                                    : t(
                                                          'web.automations.chooseConversation'
                                                      )
                                            }
                                            options={destinationOptions}
                                        />
                                    </DetailRow>
                                    {deliveryDestination === 'custom' && (
                                        <>
                                            <DetailRow
                                                label={t(
                                                    'web.automations.sendTo'
                                                )}
                                            >
                                                <WorkbenchSelect
                                                    size='sm'
                                                    className='ml-auto w-44 max-w-full text-left'
                                                    ariaLabel={t(
                                                        'web.automations.sendTo'
                                                    )}
                                                    value={deliveryKind}
                                                    onChange={(next) =>
                                                        setDeliveryKind(
                                                            next === 'user'
                                                                ? 'user'
                                                                : 'chat'
                                                        )
                                                    }
                                                    options={[
                                                        {
                                                            value: 'chat',
                                                            label: t(
                                                                'web.automations.chatGroup'
                                                            )
                                                        },
                                                        {
                                                            value: 'user',
                                                            label: t(
                                                                'web.automations.userDm'
                                                            )
                                                        }
                                                    ]}
                                                />
                                            </DetailRow>
                                            <DetailRow
                                                label={
                                                    deliveryKind === 'chat'
                                                        ? t(
                                                              'web.automations.chatId'
                                                          )
                                                        : t(
                                                              'web.automations.userId'
                                                          )
                                                }
                                                last={true}
                                            >
                                                <input
                                                    value={deliveryId}
                                                    onChange={(event) =>
                                                        setDeliveryId(
                                                            event.target.value
                                                        )
                                                    }
                                                    placeholder={
                                                        deliveryKind === 'chat'
                                                            ? t(
                                                                  'web.automations.providerChatId'
                                                              )
                                                            : t(
                                                                  'web.automations.providerUserId'
                                                              )
                                                    }
                                                    className='workbench-input ml-auto h-8 w-44 max-w-full text-right'
                                                />
                                            </DetailRow>
                                        </>
                                    )}
                                    {!scopesLoading &&
                                        scopes.length === 0 &&
                                        !savedScopeKey && (
                                            <div className='text-ui text-muted border-divider/60 border-t pt-2.5'>
                                                {supportsCustomIds
                                                    ? t(
                                                          'web.automations.noConversationsCustom'
                                                      )
                                                    : t(
                                                          'web.automations.noConversations'
                                                      )}
                                            </div>
                                        )}
                                </>
                            )}
                        </div>
                        {deliveryChannelId !== '' && (
                            <ShortcutTooltip
                                label={t('web.automations.resultNotice')}
                                placement='top'
                            >
                                <span className='text-ui text-muted mt-2 inline-flex items-start gap-1.5'>
                                    {t('web.automations.deliverNotice')}
                                    <InfoIcon className='text-placeholder mt-0.5 h-3.5 w-3.5 shrink-0' />
                                </span>
                            </ShortcutTooltip>
                        )}
                    </section>

                    <section>
                        <div className='text-ui text-subtle mb-2.5 font-medium'>
                            {t('web.automations.previousRuns')}
                        </div>
                        {detail.runs.length === 0 ? (
                            <div className='settings-card text-ui text-muted px-4 py-3.5'>
                                {t('web.automations.noRuns')}
                            </div>
                        ) : (
                            <div className='settings-card px-2 py-1.5'>
                                {visibleRuns.map((run) => (
                                    <RunRow
                                        key={run.id}
                                        agentId={detail.agentId}
                                        run={run}
                                        onRetry={() => void runNow()}
                                        retryDisabled={busy}
                                    />
                                ))}
                                {detail.runs.length > RUNS_COLLAPSED &&
                                    !runsExpanded && (
                                        <button
                                            type='button'
                                            onClick={() =>
                                                setRunsExpanded(true)
                                            }
                                            className='text-ui text-muted hover:text-fg px-2 py-2 font-medium transition-colors'
                                        >
                                            {t('web.automations.viewAllRuns')}
                                        </button>
                                    )}
                            </div>
                        )}
                    </section>
                </aside>
            </div>
            {confirmDialog}
        </div>
    )
}

const DetailRow: FC<{
    label: string
    children: ReactNode
    last?: boolean
}> = ({ label, children, last = false }): ReactNode => (
    <div
        className={
            last
                ? 'text-ui grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3'
                : 'text-ui mb-3 grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3'
        }
    >
        <div className='text-muted'>{label}</div>
        <div className='text-fg min-w-0 text-right'>{children}</div>
    </div>
)

// A null status means "not known" (an API that predates the field, or an
// automation that never ran), which must not render as in-flight.
const RunStatusMark: FC<{ status: string | null }> = ({
    status
}): ReactNode => {
    if (status === 'failed')
        return <CloseIcon className='text-error h-3.5 w-3.5 shrink-0' />
    if (status === 'succeeded')
        return <CheckIcon className='text-success h-3.5 w-3.5 shrink-0' />
    if (status === 'running')
        return (
            <span
                className='bg-warning h-2 w-2 shrink-0 rounded-full'
                aria-hidden='true'
            />
        )
    return null
}

const RunRow: FC<{
    agentId: string
    run: AutomationRunSummary
    onRetry: () => void
    retryDisabled: boolean
}> = ({ agentId, run, onRetry, retryDisabled }): ReactNode => {
    const { t } = useI18n()
    const duration = formatRunDuration(run.startedAt, run.finishedAt)
    const failed = run.status === 'failed'
    const meta = [
        duration,
        run.trigger === 'manual' ? t('web.automations.triggerManual') : null,
        run.deliveryStatus === 'sent' || run.deliveryStatus === 'queued'
            ? t('web.automations.delivered')
            : run.deliveryStatus === 'suppressed'
              ? t('web.automations.deliverySilent')
              : run.deliveryStatus === 'failed'
                ? t('web.automations.deliveryFailed')
                : null
    ].filter((entry): entry is string => Boolean(entry))

    const headline = (
        <div className='flex items-center gap-2'>
            <RunStatusMark status={run.status} />
            <span className='text-fg font-medium'>
                {run.status === 'running'
                    ? t('web.automations.running')
                    : failed
                      ? t('web.automations.failed')
                      : t('web.automations.completed')}
            </span>
            {meta.length > 0 && (
                <span className='text-placeholder min-w-0 truncate'>
                    · {meta.join(' · ')}
                </span>
            )}
            <span className='text-placeholder ml-auto shrink-0'>
                {formatRelativePast(run.startedAt)}
            </span>
        </div>
    )

    return (
        <div className='text-ui hover:bg-surface-hover rounded-sm px-2 py-2 transition-colors'>
            {run.chatSessionId ? (
                <Link
                    to={`/agents/${agentId}/chat?sessionId=${run.chatSessionId}`}
                    className='block'
                >
                    {headline}
                </Link>
            ) : (
                headline
            )}
            {(failed || run.resultPreview) && (
                <div className='mt-1 flex items-baseline gap-2 pl-5'>
                    <span
                        className={
                            failed
                                ? 'text-error min-w-0 flex-1 truncate'
                                : 'text-placeholder min-w-0 flex-1 truncate'
                        }
                    >
                        {failed
                            ? run.errorMessage || t('web.automations.failed')
                            : run.resultPreview}
                    </span>
                    {failed && (
                        <button
                            type='button'
                            onClick={onRetry}
                            disabled={retryDisabled}
                            className='text-muted hover:text-fg shrink-0 font-medium transition-colors disabled:opacity-40'
                        >
                            {t('web.automations.retry')}
                        </button>
                    )}
                </div>
            )}
        </div>
    )
}

export default AutomationDetail
