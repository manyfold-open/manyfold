import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AutomationSummary } from '@manyfold/shared'
import {
    automationTemplates,
    formatExactDateTime,
    formatNextRun,
    formatNextRunTerse,
    formatRelativePast,
    presetLabel,
    scheduleLabel,
    type AutomationTemplate
} from './automationSchedule'
import {
    AutomationsIcon,
    FileTextIcon,
    GlobeIcon,
    PlusIcon
} from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { Ghost, GhostSettingsRows } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useAppShellContext } from '@/components/AppShell'
import CreateAutomationModal from './CreateAutomationModal'
import { useI18n } from '@/lib/i18n'

const templateIcons: Record<string, FC<{ className?: string }>> = {
    briefing: AutomationsIcon,
    report: FileTextIcon,
    watch: GlobeIcon
}

const AutomationsList: FC = (): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const { agents, agentsLoading } = useAppShellContext()
    const { t } = useI18n()
    const [automations, setAutomations] = useState<AutomationSummary[]>([])
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [error, setError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [template, setTemplate] = useState<AutomationTemplate | null>(null)
    // Soonest first: the run that is about to happen is the one worth
    // scanning for, and a failing hourly automation floats to the top.
    const currentAutomations = useMemo(
        () =>
            automations
                .filter((automation) => automation.status === 'active')
                .sort(
                    (left, right) =>
                        nextRunOrder(left.nextRunAt) -
                        nextRunOrder(right.nextRunAt)
                ),
        [automations]
    )
    const pausedAutomations = useMemo(
        () =>
            automations.filter((automation) => automation.status === 'paused'),
        [automations]
    )

    const refresh = async (): Promise<void> => {
        setLoading(true)
        try {
            setAutomations(await client.automations.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
    }, [client])

    const openCreate = (next: AutomationTemplate | null): void => {
        setTemplate(next)
        setCreateOpen(true)
    }

    const ready = !loading && !gate.showLoading
    const empty = ready && automations.length === 0

    return (
        <div className='workbench-page'>
            <div className='mb-8 flex items-center justify-between gap-4'>
                <h1 className='text-h1 text-fg'>
                    {t('web.automations.title')}
                </h1>
                <button
                    type='button'
                    onClick={() => openCreate(null)}
                    className='workbench-button-primary shrink-0 gap-1.5'
                >
                    <PlusIcon className='h-4 w-4' />
                    {t('web.automations.newAction')}
                </button>
            </div>

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}
            {gate.showLoading && (
                <div className='space-y-8' aria-busy='true'>
                    <div>
                        <Ghost variant='line' className='mb-3 w-24' />
                        <div className='settings-card'>
                            <GhostSettingsRows rows={3} />
                        </div>
                    </div>
                </div>
            )}

            {empty && <AutomationsEmpty onUseTemplate={openCreate} />}

            {ready && !empty && (
                <div className='space-y-8'>
                    <AutomationSection
                        title={t('web.automations.current')}
                        automations={currentAutomations}
                        emptyMessage={t('web.automations.noneCurrent')}
                    />
                    {pausedAutomations.length > 0 && (
                        <AutomationSection
                            title={t('web.automations.paused')}
                            automations={pausedAutomations}
                        />
                    )}
                </div>
            )}

            {createOpen && (
                <CreateAutomationModal
                    agents={agents}
                    agentsLoading={agentsLoading}
                    template={template}
                    onClose={() => setCreateOpen(false)}
                    onCreated={(created) => {
                        setCreateOpen(false)
                        navigate(`/automations/${created.id}`)
                    }}
                />
            )}
        </div>
    )
}

const nextRunOrder = (value: string | null): number =>
    value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER

const AutomationSection: FC<{
    automations: AutomationSummary[]
    emptyMessage?: string
    title: string
}> = ({ automations, emptyMessage, title }): ReactNode => (
    <section>
        <h2 className='text-h3 text-fg mb-3'>{title}</h2>
        {automations.length === 0 ? (
            <div className='text-ui text-muted border-divider/70 border-t py-4'>
                {emptyMessage}
            </div>
        ) : (
            <div className='settings-card'>
                {automations.map((automation) => (
                    <AutomationRow
                        key={automation.id}
                        automation={automation}
                    />
                ))}
            </div>
        )}
    </section>
)

const AutomationRow: FC<{ automation: AutomationSummary }> = ({
    automation
}): ReactNode => {
    const paused = automation.status === 'paused'
    const failed = automation.lastRunStatus === 'failed'
    const { t } = useI18n()

    return (
        <Link
            to={`/automations/${automation.id}`}
            className='border-divider/60 hover:bg-surface-hover focus-visible:shadow-focus grid min-h-[3.25rem] grid-cols-1 items-center gap-x-3 gap-y-0.5 border-t px-4 py-2.5 transition-[color,background-color,box-shadow] first:border-t-0 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_auto]'
        >
            <div className='flex min-w-0 items-center gap-2.5'>
                {failed && !paused && (
                    <span
                        className='bg-error h-2 w-2 shrink-0 rounded-full'
                        aria-hidden='true'
                    />
                )}
                <div className='text-ui truncate font-medium'>
                    <span className={paused ? 'text-muted' : 'text-fg'}>
                        {automation.title}
                    </span>
                </div>
                <div className='text-ui text-placeholder truncate font-normal'>
                    {automation.agent.name}
                </div>
            </div>
            <AutomationMeta automation={automation} />
            <span className='sr-only'>
                {paused
                    ? t('web.automations.paused')
                    : t('web.automations.active')}
            </span>
        </Link>
    )
}

// A paused automation has no next occurrence, so its rule is the whole story.
// An active one leads with the cadence word and then the single time fact.
const AutomationMeta: FC<{ automation: AutomationSummary }> = ({
    automation
}): ReactNode => {
    const { t } = useI18n()
    const paused = automation.status === 'paused'
    const failed = automation.lastRunStatus === 'failed'
    const tooltip = automation.nextRunAt
        ? `${formatExactDateTime(automation.nextRunAt, automation.timezone)} · ${automation.timezone}`
        : scheduleLabel(automation.schedulePreset, automation.rrule)

    if (paused)
        return (
            <div className='text-ui text-placeholder shrink-0 sm:text-right'>
                {scheduleLabel(automation.schedulePreset, automation.rrule)}
            </div>
        )

    return (
        <ShortcutTooltip
            label={tooltip}
            placement='bottom-end'
            className='shrink-0 justify-self-start sm:justify-self-end'
        >
            <span className='text-ui flex items-center gap-1.5 tabular-nums'>
                {failed && automation.lastRunAt ? (
                    <span className='text-error font-medium'>
                        {t('web.automations.failedAgo', {
                            when: formatRelativePast(automation.lastRunAt)
                        })}
                    </span>
                ) : (
                    <span className='text-placeholder'>
                        {presetLabel(automation.schedulePreset)}
                    </span>
                )}
                <span className='text-placeholder' aria-hidden='true'>
                    ·
                </span>
                <span className='text-muted'>
                    {failed
                        ? t('web.automations.nextShort', {
                              when: formatNextRunTerse(
                                  automation.nextRunAt,
                                  automation.timezone
                              )
                          })
                        : formatNextRun(
                              automation.nextRunAt,
                              automation.timezone
                          )}
                </span>
            </span>
        </ShortcutTooltip>
    )
}

const AutomationsEmpty: FC<{
    onUseTemplate: (template: AutomationTemplate) => void
}> = ({ onUseTemplate }): ReactNode => {
    const { t } = useI18n()

    return (
        <div>
            <p className='text-body text-muted max-w-[65ch]'>
                {t('web.automations.emptyLead')}
            </p>
            <div className='settings-card mt-5'>
                {automationTemplates.map((template) => {
                    const Icon = templateIcons[template.id] ?? AutomationsIcon
                    return (
                        <div
                            key={template.id}
                            className='border-divider/60 flex items-center gap-3.5 border-t px-4 py-3.5 first:border-t-0'
                        >
                            <span className='bg-soft text-muted flex h-8 w-8 shrink-0 items-center justify-center rounded-sm'>
                                <Icon className='h-4 w-4' />
                            </span>
                            <div className='min-w-0 flex-1'>
                                <div className='text-ui text-fg font-medium'>
                                    {t(template.titleKey)}
                                </div>
                                <div className='text-ui text-placeholder truncate'>
                                    {t(template.promptKey)}
                                </div>
                            </div>
                            <div className='text-ui text-placeholder hidden shrink-0 sm:block'>
                                {presetLabel(template.preset)}
                            </div>
                            <button
                                type='button'
                                onClick={() => onUseTemplate(template)}
                                className='workbench-button-secondary h-8 shrink-0 px-3'
                            >
                                {t('web.automations.useTemplate')}
                            </button>
                        </div>
                    )
                })}
            </div>
            <p className='text-ui text-muted mt-3'>
                {t('web.automations.templatesHint')}
            </p>
        </div>
    )
}

export default AutomationsList
