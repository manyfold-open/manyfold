import { runtimeKindLabel } from '@manyfold/shared'
import type {
    SandboxUsageBreakdown,
    UserExternalAgentProviderSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { DaemonFrameworkTags, DaemonStatusDot } from '@/components/DaemonShared'
import { Ghost } from '@/components/Loading'
import { relative, runtimeStatusTag } from '@/components/RuntimeDetailPanel'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import {
    CloudComputerIcon,
    GridViewIcon,
    ListViewIcon,
    PlusIcon
} from '@/components/icons'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n, type TFn } from '@/lib/i18n'
import { NEW_RUNTIME_OPTIONS } from '@/lib/newRuntimeOptions'
import { providerRuntimeCounts } from '@/lib/runtimesDashboardData'
import {
    readDashboardView,
    writeDashboardView,
    type RuntimesDashboardView
} from '@/lib/runtimesDashboardView'
import { formatBytesDecimal } from '@/lib/sandboxUsageRows'
import { spriteStatusDotClass, spriteStatusLabel } from '@/lib/spriteStatus'
import { formatDuration } from '@/lib/usageFormat'
import type { RuntimeVM } from '@/pages/AgentRuntimesList'

type RuntimeKind = RuntimeVM['kind']

const SECTION_KINDS: RuntimeKind[] = ['sprites', 'k8s', 'daemon', 'external']

const SECTION_EMPTY_KEY: Record<RuntimeKind, string> = {
    sprites: 'web.runtimesDashboard.noSandboxes',
    k8s: 'web.runtimesDashboard.noClusters',
    daemon: 'web.runtimesDashboard.noMachines',
    external: 'web.runtimesDashboard.noProviders'
}

const ViewToggle: FC<{
    value: RuntimesDashboardView
    onChange: (view: RuntimesDashboardView) => void
}> = ({ value, onChange }): ReactNode => {
    const { t } = useI18n()
    const options = [
        {
            key: 'grid' as const,
            icon: GridViewIcon,
            label: t('web.runtimesDashboard.viewGrid')
        },
        {
            key: 'list' as const,
            icon: ListViewIcon,
            label: t('web.runtimesDashboard.viewList')
        }
    ]
    return (
        <div
            role='group'
            aria-label={t('web.runtimesDashboard.heading')}
            className='bg-soft shadow-ring-light inline-flex gap-1 rounded-md p-1'
        >
            {options.map((option) => {
                const Icon = option.icon
                return (
                    <button
                        key={option.key}
                        type='button'
                        aria-label={option.label}
                        aria-pressed={value === option.key}
                        onClick={() => onChange(option.key)}
                        className={[
                            'inline-flex h-7 items-center rounded-sm px-2.5 transition-colors',
                            value === option.key
                                ? 'bg-surface text-fg shadow-ring-light'
                                : 'text-muted hover:bg-surface-hover'
                        ].join(' ')}
                    >
                        <Icon className='h-4 w-4' />
                    </button>
                )
            })}
        </div>
    )
}

const providerTestTag = (
    provider: UserExternalAgentProviderSummary,
    t: TFn
): ReactNode => {
    if (provider.lastTestStatus === 'ok')
        return (
            <span className='tag tag-success shrink-0'>
                {t('web.runtimesDashboard.testPassed')}
            </span>
        )
    if (provider.lastTestStatus === 'error')
        return (
            <span className='tag tag-error shrink-0'>
                {t('web.runtimesDashboard.testFailed')}
            </span>
        )
    return (
        <span className='tag tag-neutral shrink-0'>
            {t('web.runtimesDashboard.neverTested')}
        </span>
    )
}

const MetaRow: FC<{ label: string; children: ReactNode }> = ({
    label,
    children
}): ReactNode => (
    <span className='text-caption flex items-center justify-between gap-2'>
        <span className='text-muted'>{label}</span>
        <span className='text-fg flex min-w-0 items-center gap-1.5 tabular-nums'>
            {children}
        </span>
    </span>
)

const CardHeader: FC<{ lead: ReactNode; label: string; aside?: ReactNode }> = ({
    lead,
    label,
    aside
}): ReactNode => (
    <span className='flex w-full items-center gap-2'>
        {lead}
        <span className='text-ui text-fg min-w-0 flex-1 truncate font-mono'>
            {label}
        </span>
        {aside}
    </span>
)

interface VMItemProps {
    vm: RuntimeVM
    usage: SandboxUsageBreakdown | null
    usageLoading: boolean
    onSelect: () => void
}

const vmLead = (vm: RuntimeVM): ReactNode => {
    if (vm.kind === 'sprites')
        return (
            <span
                className={[
                    'h-2 w-2 shrink-0 rounded-full',
                    spriteStatusDotClass(vm.sandbox?.spriteStatus ?? null)
                ].join(' ')}
            />
        )
    if (vm.kind === 'daemon' && vm.host)
        return <DaemonStatusDot online={vm.host.online} />
    if (vm.kind === 'k8s')
        return <CloudComputerIcon className='text-muted h-4 w-4 shrink-0' />
    const framework = vm.runtimes[0]?.framework
    return framework ? <FrameworkLogo framework={framework} size={18} /> : null
}

const spritesStorageValue = (
    vm: RuntimeVM,
    usage: SandboxUsageBreakdown | null,
    usageLoading: boolean
): ReactNode => {
    if (usageLoading && !usage) return <Ghost variant='cap' className='w-12' />
    const host = usage?.hosts.find((h) => h.hostId === vm.sandbox?.id) ?? null
    return formatBytesDecimal(host?.storageBytes ?? null)
}

const activeValue = (vm: RuntimeVM): string => {
    const seconds = vm.sandbox?.activeSecondsThisPeriod ?? 0
    return seconds > 0 ? formatDuration(seconds * 1000) : '—'
}

const VMCard: FC<VMItemProps> = ({
    vm,
    usage,
    usageLoading,
    onSelect
}): ReactNode => {
    const { t } = useI18n()
    const usageHost =
        vm.kind === 'sprites'
            ? (usage?.hosts.find((h) => h.hostId === vm.sandbox?.id) ?? null)
            : null
    return (
        <button
            type='button'
            onClick={onSelect}
            className='settings-card hover:bg-surface-hover flex flex-col gap-3 p-4 text-left transition-colors'
        >
            {vm.kind === 'sprites' && (
                <>
                    <CardHeader
                        lead={vmLead(vm)}
                        label={vm.label}
                        aside={
                            <span className='text-caption text-muted shrink-0'>
                                {spriteStatusLabel(
                                    vm.sandbox?.spriteStatus ?? null
                                )}
                            </span>
                        }
                    />
                    <span className='flex flex-col gap-1.5'>
                        <MetaRow label={t('web.runtimesDashboard.storage')}>
                            {spritesStorageValue(vm, usage, usageLoading)}
                        </MetaRow>
                        <MetaRow
                            label={t('web.runtimesDashboard.activeThisPeriod')}
                        >
                            {activeValue(vm)}
                        </MetaRow>
                        <MetaRow label={t('web.runtimesDashboard.agents')}>
                            {(usageHost?.agents ?? [])
                                .slice(0, 3)
                                .map((agent) => (
                                    <FrameworkLogo
                                        key={agent.agentId}
                                        framework={agent.framework}
                                        size={14}
                                    />
                                ))}
                            {vm.agentsCount}
                        </MetaRow>
                    </span>
                </>
            )}
            {vm.kind === 'daemon' && (
                <>
                    <CardHeader
                        lead={vmLead(vm)}
                        label={vm.label}
                        aside={
                            vm.host?.os ? (
                                <span className='text-caption text-muted shrink-0'>
                                    {vm.host.os}/{vm.host.arch ?? '?'}
                                </span>
                            ) : undefined
                        }
                    />
                    <span className='flex flex-col gap-1.5'>
                        <MetaRow label={t('web.agentRuntimesList.cliLabel')}>
                            {vm.host?.cliVersion
                                ? `v${vm.host.cliVersion}`
                                : '—'}
                            {vm.host?.updateAvailable &&
                                vm.host.latestCliVersion && (
                                    <span className='text-link'>
                                        ↑ v{vm.host.latestCliVersion}
                                    </span>
                                )}
                        </MetaRow>
                        <MetaRow label={t('web.runtimesDashboard.agents')}>
                            {vm.agentsCount}
                        </MetaRow>
                        {vm.host && !vm.host.online && (
                            <MetaRow label={t('web.agentRuntimesList.lastSeen')}>
                                {relative(vm.host.lastSeenAt)}
                            </MetaRow>
                        )}
                    </span>
                    {vm.host && <DaemonFrameworkTags host={vm.host} />}
                </>
            )}
            {vm.kind === 'k8s' && (
                <>
                    <CardHeader lead={vmLead(vm)} label={vm.label} />
                    <span className='flex flex-col gap-1.5'>
                        <MetaRow label={t('web.agentRuntimesList.location')}>
                            <span className='truncate font-mono'>
                                {vm.location}
                            </span>
                        </MetaRow>
                        <MetaRow
                            label={t('web.agentRuntimesList.runtimesTitle')}
                        >
                            {vm.runtimes.slice(0, 3).map((r) => (
                                <FrameworkLogo
                                    key={r.id}
                                    framework={r.framework}
                                    size={14}
                                />
                            ))}
                            {vm.runtimes.length}
                        </MetaRow>
                        <MetaRow label={t('web.runtimesDashboard.agents')}>
                            {vm.agentsCount}
                        </MetaRow>
                    </span>
                </>
            )}
        </button>
    )
}

// The External API section lists configured providers, not the runtimes
// bound to them — management (and creation) lives on the providers page,
// so the whole card links there.
const ProviderCard: FC<{
    provider: UserExternalAgentProviderSummary
    runtimeCount: number
}> = ({ provider, runtimeCount }): ReactNode => {
    const { t } = useI18n()
    return (
        <Link
            to='/settings/runtimes/external-agent-providers'
            className='settings-card hover:bg-surface-hover flex flex-col gap-3 p-4 text-left transition-colors'
        >
            <CardHeader
                lead={<FrameworkLogo framework={provider.provider} size={18} />}
                label={provider.label}
                aside={providerTestTag(provider, t)}
            />
            <span className='text-caption text-muted block truncate font-mono'>
                {provider.endpointUrl}
            </span>
            <span className='flex flex-col gap-1.5'>
                <MetaRow label={t('web.agentRuntimesList.runtimesTitle')}>
                    {runtimeCount}
                </MetaRow>
            </span>
        </Link>
    )
}

const headCell = 'px-4 py-3 font-medium'
const headCellRight = 'px-4 py-3 text-right font-medium'
const bodyCell = 'text-ui text-muted px-4 py-3'
const bodyCellRight = 'text-ui text-muted px-4 py-3 text-right tabular-nums'

// Whole-row activation (Enter/Space included) — the table is a navigation
// surface like the grid cards, not a data-only report.
const ClickableRow: FC<{ onSelect: () => void; children: ReactNode }> = ({
    onSelect,
    children
}): ReactNode => (
    <tr
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect()
            }
        }}
        className='border-divider/60 hover:bg-surface-hover cursor-pointer border-t transition-colors'
    >
        {children}
    </tr>
)

const nameCell = (vm: RuntimeVM): ReactNode => (
    <td className='px-4 py-3'>
        <span className='flex items-center gap-2'>
            {vmLead(vm)}
            <span className='text-ui text-fg min-w-0 truncate font-mono'>
                {vm.label}
            </span>
        </span>
    </td>
)

const VMTable: FC<{
    kind: RuntimeKind
    vms: RuntimeVM[]
    usage: SandboxUsageBreakdown | null
    usageLoading: boolean
    providers: UserExternalAgentProviderSummary[]
    runtimeCounts: Map<string, number>
    onSelectHost: (key: string) => void
}> = ({
    kind,
    vms,
    usage,
    usageLoading,
    providers,
    runtimeCounts,
    onSelectHost
}): ReactNode => {
    const { t } = useI18n()
    const navigate = useNavigate()
    const head = (): ReactNode => {
        if (kind === 'sprites')
            return (
                <tr>
                    <th className={headCell}>
                        {t('web.runtimesDashboard.colName')}
                    </th>
                    <th className={headCell}>{t('web.sandboxUsage.colStatus')}</th>
                    <th className={headCellRight}>
                        {t('web.runtimesDashboard.storage')}
                    </th>
                    <th className={headCellRight}>
                        {t('web.runtimesDashboard.activeThisPeriod')}
                    </th>
                    <th className={headCellRight}>
                        {t('web.runtimesDashboard.agents')}
                    </th>
                </tr>
            )
        if (kind === 'daemon')
            return (
                <tr>
                    <th className={headCell}>
                        {t('web.runtimesDashboard.colName')}
                    </th>
                    <th className={headCell}>{t('web.sandboxUsage.colStatus')}</th>
                    <th className={headCell}>{t('web.agentRuntimesList.os')}</th>
                    <th className={headCell}>
                        {t('web.agentRuntimesList.cliLabel')}
                    </th>
                    <th className={headCellRight}>
                        {t('web.runtimesDashboard.agents')}
                    </th>
                    <th className={headCell}>
                        {t('web.agentRuntimesList.lastSeen')}
                    </th>
                </tr>
            )
        if (kind === 'k8s')
            return (
                <tr>
                    <th className={headCell}>
                        {t('web.runtimesDashboard.colName')}
                    </th>
                    <th className={headCell}>{t('web.sandboxUsage.colStatus')}</th>
                    <th className={headCell}>
                        {t('web.agentRuntimesList.location')}
                    </th>
                    <th className={headCellRight}>
                        {t('web.agentRuntimesList.runtimesTitle')}
                    </th>
                    <th className={headCellRight}>
                        {t('web.runtimesDashboard.agents')}
                    </th>
                </tr>
            )
        return (
            <tr>
                <th className={headCell}>{t('web.runtimesDashboard.colName')}</th>
                <th className={headCell}>{t('web.runtimeDetail.endpoint')}</th>
                <th className={headCell}>
                    {t('web.runtimesDashboard.colLastTest')}
                </th>
                <th className={headCellRight}>
                    {t('web.agentRuntimesList.runtimesTitle')}
                </th>
            </tr>
        )
    }

    const row = (vm: RuntimeVM): ReactNode => {
        if (vm.kind === 'sprites') {
            const usageHost =
                usage?.hosts.find((h) => h.hostId === vm.sandbox?.id) ?? null
            return (
                <ClickableRow key={vm.key} onSelect={() => onSelectHost(vm.key)}>
                    {nameCell(vm)}
                    <td className={bodyCell}>
                        {spriteStatusLabel(vm.sandbox?.spriteStatus ?? null)}
                    </td>
                    <td className={bodyCellRight}>
                        {usageLoading && !usage ? (
                            <Ghost variant='cap' className='ml-auto w-12' />
                        ) : (
                            formatBytesDecimal(usageHost?.storageBytes ?? null)
                        )}
                    </td>
                    <td className={bodyCellRight}>{activeValue(vm)}</td>
                    <td className={bodyCellRight}>{vm.agentsCount}</td>
                </ClickableRow>
            )
        }
        if (vm.kind === 'daemon')
            return (
                <ClickableRow key={vm.key} onSelect={() => onSelectHost(vm.key)}>
                    {nameCell(vm)}
                    <td className={bodyCell}>
                        {t(
                            vm.host?.online
                                ? 'web.connectDaemon.online'
                                : 'web.connectDaemon.offline'
                        )}
                    </td>
                    <td className={bodyCell}>
                        {vm.host?.os
                            ? `${vm.host.os}/${vm.host.arch ?? '?'}`
                            : '—'}
                    </td>
                    <td className={`${bodyCell} whitespace-nowrap`}>
                        {vm.host?.cliVersion ? `v${vm.host.cliVersion}` : '—'}
                        {vm.host?.updateAvailable &&
                            vm.host.latestCliVersion && (
                                <span className='text-link'>
                                    {' '}
                                    ↑ v{vm.host.latestCliVersion}
                                </span>
                            )}
                    </td>
                    <td className={bodyCellRight}>{vm.agentsCount}</td>
                    <td className={`${bodyCell} whitespace-nowrap`}>
                        {relative(vm.host?.lastSeenAt ?? null)}
                    </td>
                </ClickableRow>
            )
        if (vm.kind === 'k8s')
            return (
                <ClickableRow key={vm.key} onSelect={() => onSelectHost(vm.key)}>
                    {nameCell(vm)}
                    <td className={bodyCell}>
                        {vm.status ? runtimeStatusTag(vm.status) : '—'}
                    </td>
                    <td className={`${bodyCell} max-w-56 truncate font-mono`}>
                        {vm.location}
                    </td>
                    <td className={bodyCellRight}>{vm.runtimes.length}</td>
                    <td className={bodyCellRight}>{vm.agentsCount}</td>
                </ClickableRow>
            )
        return null
    }

    return (
        <div className='settings-card overflow-x-auto'>
            <table className='w-full min-w-[36rem] text-left'>
                <thead className='workbench-table-head'>{head()}</thead>
                <tbody>
                    {kind === 'external'
                        ? providers.map((p) => (
                              <ClickableRow
                                  key={p.id}
                                  onSelect={() =>
                                      navigate(
                                          '/settings/runtimes/external-agent-providers'
                                      )
                                  }
                              >
                                  <td className='px-4 py-3'>
                                      <span className='flex items-center gap-2'>
                                          <FrameworkLogo
                                              framework={p.provider}
                                              size={18}
                                          />
                                          <span className='text-ui text-fg min-w-0 truncate'>
                                              {p.label}
                                          </span>
                                      </span>
                                  </td>
                                  <td
                                      className={`${bodyCell} max-w-64 truncate font-mono`}
                                  >
                                      {p.endpointUrl}
                                  </td>
                                  <td className={bodyCell}>
                                      {providerTestTag(p, t)}
                                  </td>
                                  <td className={bodyCellRight}>
                                      {runtimeCounts.get(p.id) ?? 0}
                                  </td>
                              </ClickableRow>
                          ))
                        : vms.map(row)}
                </tbody>
            </table>
        </div>
    )
}

interface RuntimesDashboardProps {
    vms: RuntimeVM[]
    usage: SandboxUsageBreakdown | null
    usageLoading: boolean
    providers: UserExternalAgentProviderSummary[] | null
    cloudComputerEnabled: boolean
    onSelectHost: (key: string) => void
}

const RuntimesDashboard: FC<RuntimesDashboardProps> = ({
    vms,
    usage,
    usageLoading,
    providers,
    cloudComputerEnabled,
    onSelectHost
}): ReactNode => {
    const { t } = useI18n()
    const [view, setView] = useState<RuntimesDashboardView>(readDashboardView)
    const changeView = (next: RuntimesDashboardView): void => {
        setView(next)
        writeDashboardView(next)
    }

    const byKind = useMemo(() => {
        const out = new Map<RuntimeKind, RuntimeVM[]>()
        for (const vm of vms) {
            const list = out.get(vm.kind) ?? []
            list.push(vm)
            out.set(vm.kind, list)
        }
        return out
    }, [vms])

    const externalVms = byKind.get('external') ?? []
    const sectionProviders = useMemo(() => providers ?? [], [providers])
    const providerCounts = useMemo(
        () =>
            providerRuntimeCounts(
                sectionProviders,
                externalVms.map((vm) => vm.runtimes[0]?.endpointUrl)
            ),
        [sectionProviders, externalVms]
    )

    const renderSection = (kind: RuntimeKind): ReactNode => {
        const sectionVms = byKind.get(kind) ?? []
        if (kind === 'k8s' && !cloudComputerEnabled && sectionVms.length === 0)
            return null
        const option = NEW_RUNTIME_OPTIONS.find((o) => o.kind === kind)
        const showCreate =
            option && (!option.requiresCloudComputer || cloudComputerEnabled)
        const sectionCount =
            kind === 'external' ? sectionProviders.length : sectionVms.length
        const empty = sectionCount === 0
        return (
            <section key={kind} aria-busy={kind === 'sprites' && usageLoading}>
                <div className='mb-3 flex flex-wrap items-center gap-2'>
                    <h2 className='text-ui text-fg font-medium'>
                        {runtimeKindLabel(kind)}
                    </h2>
                    <span className='tag tag-neutral tabular-nums'>
                        {sectionCount}
                    </span>
                    <span className='min-w-2 flex-1' />
                    {kind === 'sprites' && (
                        <Link
                            to='/settings/plan-and-billing/sandbox-usage'
                            className='text-caption text-link hover:text-fg transition-colors'
                        >
                            {t('web.runtimesDashboard.usageDetails')}
                        </Link>
                    )}
                    {showCreate && (
                        <Link
                            to={option.to}
                            className='workbench-button-secondary h-8 gap-1.5 px-3'
                        >
                            <PlusIcon className='h-3.5 w-3.5' />
                            {t(option.createLabelKey)}
                        </Link>
                    )}
                </div>
                {empty ? (
                    <p className='text-caption text-muted'>
                        {t(SECTION_EMPTY_KEY[kind])}
                    </p>
                ) : view === 'grid' ? (
                    <div className='grid gap-3 sm:grid-cols-2'>
                        {kind === 'external'
                            ? sectionProviders.map((p) => (
                                  <ProviderCard
                                      key={p.id}
                                      provider={p}
                                      runtimeCount={
                                          providerCounts.get(p.id) ?? 0
                                      }
                                  />
                              ))
                            : sectionVms.map((vm) => (
                                  <VMCard
                                      key={vm.key}
                                      vm={vm}
                                      usage={usage}
                                      usageLoading={usageLoading}
                                      onSelect={() => onSelectHost(vm.key)}
                                  />
                              ))}
                    </div>
                ) : (
                    <VMTable
                        kind={kind}
                        vms={sectionVms}
                        usage={usage}
                        usageLoading={usageLoading}
                        providers={kind === 'external' ? sectionProviders : []}
                        runtimeCounts={providerCounts}
                        onSelectHost={onSelectHost}
                    />
                )}
            </section>
        )
    }

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                title={t('web.runtimesDashboard.heading')}
                actions={<ViewToggle value={view} onChange={changeView} />}
            />
            <div className='space-y-8'>{SECTION_KINDS.map(renderSection)}</div>
        </div>
    )
}

export default RuntimesDashboard
