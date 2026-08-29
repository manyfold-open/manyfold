import type { FC, ReactNode } from 'react'
import { GridViewIcon, ListViewIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'
import type { DashboardView } from '@/lib/dashboardView'

// Shared dashboard card primitives. Three settings dashboards render the same
// card anatomy; keeping one copy is what stops their rows drifting apart.

export const MetaRow: FC<{ label: string; children: ReactNode }> = ({
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

export const CardHeader: FC<{
    lead: ReactNode
    label: string
    aside?: ReactNode
}> = ({ lead, label, aside }): ReactNode => (
    <span className='flex w-full items-center gap-2'>
        {lead}
        <span className='text-ui text-fg min-w-0 flex-1 truncate font-mono'>
            {label}
        </span>
        {aside}
    </span>
)

export const DashboardViewToggle: FC<{
    value: DashboardView
    onChange: (view: DashboardView) => void
    ariaLabel: string
}> = ({ value, onChange, ariaLabel }): ReactNode => {
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
            aria-label={ariaLabel}
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
