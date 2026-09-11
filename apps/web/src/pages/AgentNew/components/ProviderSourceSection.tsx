import type { FC, ReactNode } from 'react'
import type { AgentFramework, AgentRuntimeSummary } from '@manyfold/shared'
import { FilterChip, FilterChipRow } from '@/components/FilterChip'
import {
    localSourceAvailable,
    providerSourceOf,
    type ProviderPickerMode,
    type ProviderSourceFilter,
    type ProviderTarget
} from '@/lib/agentCreate/providerSource'
import { useI18n } from '@/lib/i18n'
import type { WakeRefusal } from '@/lib/wakeRefusal'
import {
    LocalCredentialsPanel,
    type RuntimeAuthListState,
    type SandboxPrepare
} from '@/pages/AgentNew/components/LocalCredentialsPanel'

// The create form's provider section, built like its runtime section: a chip
// row, ONE grid of pick cards — the saved providers (Cloud) and the runtime's
// accounts (Local) side by side — and one row of dashed add chips under it.
// The chips only filter what is shown; the cards carry the selection.
// Frameworks without a runtime-local surface get the caller's Cloud node
// alone, with no chips.
export const ProviderSourceSection: FC<{
    framework: AgentFramework
    target: ProviderTarget
    pickerMode: ProviderPickerMode
    filter: ProviderSourceFilter
    onFilterChange: (next: ProviderSourceFilter) => void
    // The self-contained Cloud node for frameworks that have no Local side.
    cloud: ReactNode
    // The Cloud pieces for the unified layout: the provider cards and the
    // add chip.
    cloudCards: ReactNode
    cloudActions: ReactNode
    cloudCount: number
    localCount: number
    localProfileId: string
    onLocalSelect: (profileId: string) => void
    runtime: AgentRuntimeSummary | null
    auth: RuntimeAuthListState
    prewarming?: boolean
    // A wake the plan refused, ending the wait; shown in the runner line.
    wakeRefusal?: WakeRefusal | null
    onRetryWake?: () => void
    prepare?: SandboxPrepare | null
    autoAddKey?: string | null
}> = ({
    framework,
    target,
    pickerMode,
    filter,
    onFilterChange,
    cloud,
    cloudCards,
    cloudActions,
    cloudCount,
    localCount,
    localProfileId,
    onLocalSelect,
    runtime,
    auth,
    prewarming = false,
    wakeRefusal = null,
    onRetryWake,
    prepare = null,
    autoAddKey = null
}): ReactNode => {
    const { t } = useI18n()
    if (!localSourceAvailable(framework)) return cloud
    const chips: ReadonlyArray<{ value: ProviderSourceFilter; count: number }> =
        [
            { value: 'all', count: cloudCount + localCount },
            { value: 'cloud', count: cloudCount },
            { value: 'local', count: localCount }
        ]
    const chipLabel = (value: ProviderSourceFilter): string =>
        value === 'all'
            ? t('web.agentNew.filterAll')
            : value === 'cloud'
              ? t('web.agentNew.providerSourceCloud')
              : t('web.agentNew.providerSourceLocal')
    const showCloud = filter !== 'local'
    const showLocal = filter !== 'cloud'
    return (
        <div className='space-y-2'>
            <FilterChipRow ariaLabel={t('web.agentNew.providerSourceAria')}>
                {chips.map((chip) => (
                    <FilterChip
                        key={chip.value}
                        label={chipLabel(chip.value)}
                        count={chip.count}
                        active={filter === chip.value}
                        onSelect={() => onFilterChange(chip.value)}
                    />
                ))}
            </FilterChipRow>
            <LocalCredentialsPanel
                framework={framework}
                target={target}
                runtime={runtime}
                auth={auth}
                active={providerSourceOf(pickerMode) === 'local'}
                profileId={localProfileId}
                onSelect={onLocalSelect}
                prewarming={prewarming}
                wakeRefusal={wakeRefusal}
                onRetryWake={onRetryWake}
                prepare={prepare}
                autoAddKey={autoAddKey}
                layout={(local) => (
                    <>
                        <div className='grid gap-2 sm:grid-cols-2'>
                            {showCloud && cloudCards}
                            {showLocal && local.cards}
                        </div>
                        {showLocal && local.notices}
                        <div className='flex flex-wrap gap-2'>
                            {showCloud && cloudActions}
                            {showLocal && local.actions}
                        </div>
                        {showLocal && local.extra}
                    </>
                )}
            />
        </div>
    )
}
