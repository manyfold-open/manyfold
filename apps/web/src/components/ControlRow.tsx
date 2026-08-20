import type { FC, ReactNode } from 'react'
import { Spinner } from '@/components/Loading'
import { t } from '@manyfold/i18n'

// Product toggle switch — the one grammar for boolean settings with an
// immediate server effect. State and control are a single widget: off is
// a soft ringed track, on fills with --color-strong (ink in light,
// platinum in dark) and the thumb inverts to --color-strong-fg so the
// contrast pair always holds in both themes.
export const Switch: FC<{
    checked: boolean
    disabled?: boolean
    onChange: () => void
    ariaLabel: string
}> = ({ checked, disabled, onChange, ariaLabel }): ReactNode => (
    <button
        type='button'
        role='switch'
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onChange}
        className={[
            'rounded-pill focus-visible:shadow-focus relative inline-flex h-5 w-9 shrink-0 items-center transition-[color,background-color,box-shadow] duration-150 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
            checked ? 'bg-strong' : 'bg-soft shadow-ring-light'
        ].join(' ')}
    >
        <span
            className={[
                'rounded-pill shadow-ring-light pointer-events-none absolute left-0.5 h-4 w-4 transition-transform duration-150',
                checked
                    ? 'bg-strong-fg translate-x-4'
                    : 'bg-surface translate-x-0'
            ].join(' ')}
        />
    </button>
)

// Shared enable/disable row for runtime-level switches (control UI,
// dashboard, keep-alive, terminal) used by the runtime detail panel and
// the agent detail page. The switch carries the state; while a toggle is
// in flight the row shows a spinner + progress caption and the switch
// locks.
export const ControlRow: FC<{
    label: string
    description?: string
    enabled: boolean
    pending: boolean
    pendingLabel: string
    onToggle: () => void
    onOpen?: () => void
    openLabel?: string
    error?: string | null
}> = ({
    label,
    description,
    enabled,
    pending,
    pendingLabel,
    onToggle,
    onOpen,
    openLabel,
    error
}): ReactNode => (
    <div className='settings-card-row'>
        <div className='min-w-0'>
            <div className='settings-card-label'>{label}</div>
            {description && (
                <div className='settings-card-copy'>{description}</div>
            )}
            {error && (
                <div className='text-caption text-error mt-1.5'>{error}</div>
            )}
        </div>
        <div className='settings-card-side'>
            {enabled && onOpen && (
                <button
                    type='button'
                    onClick={onOpen}
                    className='text-ui text-link hover:text-fg font-medium transition-colors'
                >
                    {openLabel ?? t('web.controlRow.open')}
                </button>
            )}
            {pending && (
                <span className='text-caption text-muted inline-flex items-center gap-1.5'>
                    <Spinner size={12} />
                    {pendingLabel}
                </span>
            )}
            <Switch
                checked={enabled}
                disabled={pending}
                onChange={onToggle}
                ariaLabel={label}
            />
        </div>
    </div>
)

// Dashboard toggle progress helpers — dashboard_state grammar:
// 'enabling@<ISO>' | 'disabling@<ISO>' | 'error:<reason>' | null.
export const dashboardStatePending = (state: string | null): boolean =>
    !!state && !state.startsWith('error:')

export const dashboardStateError = (state: string | null): string | null =>
    state?.startsWith('error:') ? state.slice('error:'.length) : null

export const dashboardStatePendingLabel = (
    state: string | null,
    fallback: string
): string =>
    state?.startsWith('enabling@')
        ? t('web.controlRow.enabling')
        : state?.startsWith('disabling@')
          ? t('web.controlRow.disabling')
          : fallback
