import type { FC, ReactNode } from 'react'
import { FilterChip, FilterChipRow } from '@/components/FilterChip'
import type { ProviderFamilyFilter } from '@/lib/agentCreate/providerSource'
import { useI18n } from '@/lib/i18n'

// The provider section for a framework without a Local side (OpenClaw,
// Hermes, NarraNexus), in the same shape as the Cloud / Local one: a chip
// row that only filters, ONE grid of pick cards, one row of dashed add
// chips. Here the chips are the provider families the framework can talk
// to; a framework that takes no provider at all gets the grid alone, with
// the caller's one card saying so.
export const ProviderFamilySection: FC<{
    chips: ReadonlyArray<{
        value: ProviderFamilyFilter
        label: string
        count: number
    }>
    filter: ProviderFamilyFilter
    onFilterChange: (next: ProviderFamilyFilter) => void
    cards: ReactNode
    actions?: ReactNode
}> = ({ chips, filter, onFilterChange, cards, actions }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='space-y-2'>
            {chips.length > 0 && (
                <FilterChipRow ariaLabel={t('web.agentNew.providerFamilyAria')}>
                    {chips.map((chip) => (
                        <FilterChip
                            key={chip.value}
                            label={chip.label}
                            count={chip.count}
                            active={filter === chip.value}
                            onSelect={() => onFilterChange(chip.value)}
                        />
                    ))}
                </FilterChipRow>
            )}
            <div className='grid gap-2 sm:grid-cols-2'>{cards}</div>
            {actions && <div className='flex flex-wrap gap-2'>{actions}</div>}
        </div>
    )
}
