import {
    AgentFramework,
    UserModelProvider,
    UserModelProviderSummary,
    brandFor
} from '@manyfold/shared'
import { useEffect, useMemo } from 'react'
import type { FC, ReactNode } from 'react'
import { CheckIcon, RefreshIcon, type LucideIcon } from '@/components/icons'
import { Spinner } from '@/components/Loading'
import {
    NEW_RUNTIME_TARGET,
    initialPickerModeFor,
    protocolModelCounts,
    selectableProvidersForFamilies,
    type ProviderPickerMode,
    type ProviderTarget
} from '@/lib/agentCreate/providerSource'
import {
    inferenceProtocolLabel,
    providerLabel
} from '@/pages/Settings/ModelProviderFields'
import { useI18n } from '@/lib/i18n'

export interface ProviderPickerValue {
    // 'runtime' = use the coding CLI's own sign-in inside the
    // sandbox/computer (a subscription plan); the create body then carries
    // modelConfigSource 'runtime-local' and no credentials; see
    // providerSource.ts for the Cloud / Local split.
    mode: ProviderPickerMode
    providerId: string
    apiKey: string
    baseUrl: string
    save: boolean
    saveLabel: string
}

export const initialPicker = (): ProviderPickerValue => ({
    mode: 'saved',
    providerId: '',
    apiKey: '',
    baseUrl: '',
    save: false,
    saveLabel: ''
})

// Create-form starting mode: the edition slot decides Cloud vs Local for
// coding frameworks, and a daemon target always starts Local.
export const initialPickerForFramework = (
    framework: AgentFramework,
    target: ProviderTarget = NEW_RUNTIME_TARGET
): ProviderPickerValue => ({
    ...initialPicker(),
    mode: initialPickerModeFor(framework, target)
})

export const pickerIsValid = (v: ProviderPickerValue): boolean => {
    if (v.mode === 'runtime') return true
    if (v.mode === 'saved') return v.providerId.length > 0
    if (v.apiKey.length < 10) return false
    if (v.save && !/^[A-Za-z0-9][A-Za-z0-9_\- .]{0,63}$/.test(v.saveLabel))
        return false
    return true
}

// §8.12 pick-one list: the row itself is the control, selection is the
// trailing check plus the soft fill, classification stays a quiet tag. The
// card is the wrapper; the pick target is the button filling its left side,
// and the right column stacks the check over an optional action button, so
// the action is never nested in the pick target and the card stays as tall
// as its text.
export interface PickerRowAction {
    icon: LucideIcon
    label: string
    onClick: () => void
    busy?: boolean
    disabled?: boolean
}

export const PickerRow: FC<{
    selected: boolean
    onClick: () => void
    title: ReactNode
    subtitle?: ReactNode
    description?: ReactNode
    lead?: ReactNode
    tags?: string[]
    disabled?: boolean
    action?: PickerRowAction
}> = ({
    selected,
    onClick,
    title,
    subtitle,
    description,
    lead,
    tags = [],
    disabled = false,
    action
}): ReactNode => {
    const Icon = action?.icon
    return (
        <div
            className={[
                'shadow-ring-light flex min-h-10 min-w-0 rounded-md transition-[color,background-color,box-shadow]',
                // The same picked state as the runtime and account cards
                // above and beside it: the info tint plus the link ring.
                selected
                    ? 'bg-info-bg text-fg ring-link/40 ring-2'
                    : 'text-muted hover:text-fg bg-surface hover:bg-surface-hover',
                disabled ? 'opacity-55' : ''
            ].join(' ')}
        >
            <button
                type='button'
                onClick={onClick}
                disabled={disabled}
                aria-pressed={selected}
                className='focus-visible:shadow-focus flex min-w-0 flex-1 items-start gap-2.5 rounded-md py-2 pl-3 pr-1 text-left transition-[box-shadow] focus:outline-none disabled:cursor-not-allowed'
            >
                {lead && (
                    <span className='shadow-ring-light bg-surface flex h-7 w-7 shrink-0 items-center justify-center rounded-sm'>
                        {lead}
                    </span>
                )}
                <span className='min-w-0 flex-1'>
                    <span className='text-ui flex flex-wrap items-center gap-x-2 gap-y-1 font-medium'>
                        <span className='truncate'>{title}</span>
                        {tags.map((tag) => (
                            <span key={tag} className='tag tag-neutral'>
                                {tag}
                            </span>
                        ))}
                    </span>
                    {subtitle && (
                        <span className='text-caption text-subtle block truncate'>
                            {subtitle}
                        </span>
                    )}
                    {description && (
                        <span className='text-caption text-muted mt-0.5 block'>
                            {description}
                        </span>
                    )}
                </span>
            </button>
            <span className='flex w-8 shrink-0 flex-col items-center justify-between py-2 pr-1.5'>
                <CheckIcon
                    aria-hidden
                    className={[
                        'text-link mt-0.5 h-4 w-4',
                        selected ? '' : 'invisible'
                    ].join(' ')}
                />
                {action && Icon && (
                    <button
                        type='button'
                        aria-label={action.label}
                        title={action.label}
                        aria-busy={action.busy}
                        disabled={action.disabled || action.busy}
                        onClick={action.onClick}
                        className='shadow-ring-light focus-visible:shadow-focus text-muted hover:text-fg bg-surface hover:bg-surface-hover flex h-6 w-6 items-center justify-center rounded-sm transition-[color,background-color,box-shadow] focus:outline-none disabled:cursor-not-allowed disabled:opacity-55'
                    >
                        {action.busy ? (
                            <Spinner size={12} />
                        ) : (
                            <Icon className='h-3.5 w-3.5' aria-hidden='true' />
                        )}
                    </button>
                )}
            </span>
        </div>
    )
}

interface Props {
    provider: UserModelProvider
    // The families the saved list draws from (default: `provider` alone).
    // OpenClaw / Hermes list both vendors' providers and filter by chip.
    families?: readonly UserModelProvider[]
    // Rows the caller's chip row currently hides; the pick itself and the
    // auto-select stay over the whole list, as filtering never selects.
    visible?: (row: UserModelProviderSummary) => boolean
    framework?: AgentFramework
    label?: string
    apiKeyLabel: string
    apiKeyHint?: string
    baseUrlLabel: string
    baseUrlPlaceholder?: string
    defaultBaseUrl?: string
    showBaseUrl?: boolean
    // Offer the in-runtime subscription sign-in mode. Opt-in per surface:
    // the create forms enable it for configurable frameworks, while the
    // credentials-edit dialog must not (its job is the platform key; the
    // source switch lives in the composer/settings).
    allowRuntimeMode?: boolean
    // The agent-scoped pasted key (mode 'inline'). The v1 create form adds
    // providers through the settings dialog instead and switches this off.
    allowInlineKey?: boolean
    // Two rows per line on wide screens (the create form); the dialogs keep
    // one.
    columns?: 1 | 2
    // 'rows' renders only the provider rows, for a caller that lays them out
    // in its own grid beside other pick rows (the create form's provider
    // section); 'section' is the self-contained label + grid.
    layout?: 'section' | 'rows'
    // A refresh beside each saved row: re-run that provider's test so its
    // model list (and the row's counts) are current. `refreshingId` is the
    // row whose test is running.
    onRefresh?: (providerId: string) => void
    refreshingId?: string | null
    // The brand mark for a saved row. Injected rather than imported: the
    // marks are SVG assets, and this module is loaded by node:test.
    leadFor?: (row: UserModelProviderSummary) => ReactNode
    options: UserModelProviderSummary[]
    value: ProviderPickerValue
    onChange: (next: ProviderPickerValue) => void
    autoSelectFirst?: boolean
}

export const ProviderPicker: FC<Props> = ({
    provider,
    families,
    visible,
    framework,
    label,
    apiKeyLabel,
    apiKeyHint,
    baseUrlLabel,
    baseUrlPlaceholder,
    defaultBaseUrl,
    showBaseUrl = true,
    allowRuntimeMode = false,
    allowInlineKey = true,
    columns = 1,
    layout = 'section',
    onRefresh,
    refreshingId = null,
    leadFor,
    options,
    value,
    onChange,
    autoSelectFirst = true
}): ReactNode => {
    const { t } = useI18n()
    const filtered = useMemo(
        () =>
            selectableProvidersForFamilies(
                options,
                families ?? [provider],
                framework
            ),
        [options, families, provider, framework]
    )

    useEffect(() => {
        const selectedExists = filtered.some((o) => o.id === value.providerId)
        if (allowInlineKey && filtered.length === 0 && value.mode === 'saved') {
            onChange({ ...value, mode: 'inline' })
            return
        }
        if (
            autoSelectFirst &&
            filtered.length > 0 &&
            value.mode === 'saved' &&
            !selectedExists
        ) {
            onChange({ ...value, providerId: filtered[0].id })
        }
    }, [allowInlineKey, autoSelectFirst, filtered, onChange, value])

    const rows = (visible ? filtered.filter(visible) : filtered).map((o) => {
        const brand = brandFor(o)
        const counts = protocolModelCounts(o)
        const status =
            o.lastTestStatus === 'error'
                ? t('web.agentNew.providerTestFailedTag')
                : !o.lastTestedAt
                  ? t('web.shell.modelNeedsTest')
                  : null
        return (
            <PickerRow
                key={o.id}
                selected={value.mode === 'saved' && value.providerId === o.id}
                onClick={() =>
                    onChange({
                        ...value,
                        mode: 'saved',
                        providerId: o.id
                    })
                }
                lead={leadFor?.(o)}
                title={o.providerName}
                subtitle={o.apiKeyMasked}
                description={
                    counts.length > 0
                        ? counts
                              .map(
                                  (c) =>
                                      `${
                                          (
                                              inferenceProtocolLabel as Record<
                                                  string,
                                                  string
                                              >
                                          )[c.protocol] ?? c.protocol
                                      } · ${t('web.agentNew.providerModelCount', { count: c.count })}`
                              )
                              .join(' · ')
                        : undefined
                }
                tags={[
                    brand
                        ? providerLabel[brand]
                        : t('web.agentNew.customProvider'),
                    ...(o.source === 'managed'
                        ? [t('web.agentNew.managed')]
                        : []),
                    ...(status ? [status] : [])
                ]}
                action={
                    onRefresh
                        ? {
                              icon: RefreshIcon,
                              label: t('web.agentNew.testProvider'),
                              onClick: () => onRefresh(o.id),
                              busy: refreshingId === o.id
                          }
                        : undefined
                }
            />
        )
    })
    if (layout === 'rows') return <>{rows}</>
    return (
        <div className='space-y-3'>
            <div>
                <span className='workbench-field-label'>
                    {label ?? t('web.agentNew.provider')}
                </span>
                <div
                    className={
                        columns === 2
                            ? 'grid gap-2 md:grid-cols-2'
                            : 'grid gap-2'
                    }
                >
                    {rows}
                    {allowRuntimeMode && (
                        <PickerRow
                            selected={value.mode === 'runtime'}
                            onClick={() =>
                                onChange({
                                    ...value,
                                    mode: 'runtime',
                                    providerId: ''
                                })
                            }
                            title={t('web.agentNew.useOwnSubscription')}
                            subtitle={t('web.agentNew.subscriptionSignInHint')}
                        />
                    )}
                    {allowInlineKey && (
                        <PickerRow
                            selected={value.mode === 'inline'}
                            onClick={() =>
                                onChange({
                                    ...value,
                                    mode: 'inline',
                                    providerId: ''
                                })
                            }
                            title={t('web.agentNew.useNewApiKey')}
                            subtitle={t('web.agentNew.provideCredentials')}
                        />
                    )}
                </div>
                {filtered.length === 0 && allowInlineKey && (
                    <p className='workbench-hint'>
                        {t('web.agentNew.noSavedKeys')}{' '}
                        <a
                            className='text-link hover:text-fg'
                            href='/settings/model-providers?selected=custom-new'
                        >
                            {t('web.agentNew.addModelProvider')}
                        </a>{' '}
                        {t('web.agentNew.reuseAcrossAgents')}
                    </p>
                )}
            </div>

            {allowRuntimeMode && value.mode === 'runtime' && (
                <div className='shadow-ring-light bg-soft space-y-1 rounded-md p-4'>
                    <p className='text-ui text-fg'>
                        {t('web.agentNew.subscriptionSignInExplainer')}
                    </p>
                    <p className='workbench-hint'>
                        {t('web.agentNew.subscriptionSignInPrivacy')}
                    </p>
                </div>
            )}

            {allowInlineKey && value.mode === 'inline' && (
                <div className='shadow-ring-light bg-soft space-y-4 rounded-md p-4'>
                    <label className='block'>
                        <span className='workbench-field-label'>
                            {apiKeyLabel}
                        </span>
                        <input
                            type='password'
                            autoComplete='off'
                            required
                            minLength={10}
                            maxLength={1024}
                            value={value.apiKey}
                            onChange={(e) =>
                                onChange({ ...value, apiKey: e.target.value })
                            }
                            className='workbench-input font-mono'
                        />
                        {apiKeyHint && (
                            <p className='workbench-hint'>{apiKeyHint}</p>
                        )}
                    </label>
                    {showBaseUrl && (
                        <label className='block'>
                            <span className='workbench-field-label'>
                                {baseUrlLabel}
                            </span>
                            <input
                                type='url'
                                value={value.baseUrl}
                                onChange={(e) =>
                                    onChange({
                                        ...value,
                                        baseUrl: e.target.value
                                    })
                                }
                                placeholder={baseUrlPlaceholder ?? ''}
                                className='workbench-input font-mono'
                            />
                            {defaultBaseUrl && (
                                <p className='workbench-hint'>
                                    {t(
                                        'web.agentNew.leaveBlankOfficialEndpoint'
                                    )}{' '}
                                    <a
                                        className='text-link hover:text-fg font-mono'
                                        href={defaultBaseUrl}
                                        target='_blank'
                                        rel='noreferrer'
                                    >
                                        {defaultBaseUrl}
                                    </a>
                                </p>
                            )}
                        </label>
                    )}
                    <div className='space-y-2 pt-1'>
                        <label className='text-ui text-fg flex items-center gap-2'>
                            <input
                                type='checkbox'
                                checked={value.save}
                                onChange={(e) =>
                                    onChange({
                                        ...value,
                                        save: e.target.checked
                                    })
                                }
                                className='accent-fg'
                            />
                            {t('web.agentNew.saveApiKey')}
                        </label>
                        {value.save && (
                            <input
                                type='text'
                                required
                                pattern='^[A-Za-z0-9][A-Za-z0-9_\- .]*$'
                                minLength={1}
                                maxLength={64}
                                value={value.saveLabel}
                                onChange={(e) =>
                                    onChange({
                                        ...value,
                                        saveLabel: e.target.value
                                    })
                                }
                                placeholder={t(
                                    'web.agentNew.keyLabelPlaceholder'
                                )}
                                className='workbench-input'
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
