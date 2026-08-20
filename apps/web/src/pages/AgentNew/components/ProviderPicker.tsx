import {
    AgentFramework,
    UserModelProvider,
    UserModelProviderSummary,
    brandFor,
    frameworkSupportsProtocol,
    isManagedProtocolAllowedForFramework,
    providerProtocolForTarget,
    providerSupportsTarget
} from '@manyfold/shared'
import { useEffect, useMemo } from 'react'
import type { FC, ReactNode } from 'react'
import { providerLabel } from '@/pages/Settings/ModelProviderFields'
import { useI18n } from '@/lib/i18n'

export interface ProviderPickerValue {
    mode: 'saved' | 'inline'
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

export const pickerIsValid = (v: ProviderPickerValue): boolean => {
    if (v.mode === 'saved') return v.providerId.length > 0
    if (v.apiKey.length < 10) return false
    if (v.save && !/^[A-Za-z0-9][A-Za-z0-9_\- .]{0,63}$/.test(v.saveLabel))
        return false
    return true
}

interface Props {
    provider: UserModelProvider
    framework?: AgentFramework
    label?: string
    apiKeyLabel: string
    apiKeyHint?: string
    baseUrlLabel: string
    baseUrlPlaceholder?: string
    defaultBaseUrl?: string
    showBaseUrl?: boolean
    options: UserModelProviderSummary[]
    value: ProviderPickerValue
    onChange: (next: ProviderPickerValue) => void
    autoSelectFirst?: boolean
}

export const ProviderPicker: FC<Props> = ({
    provider,
    framework,
    label,
    apiKeyLabel,
    apiKeyHint,
    baseUrlLabel,
    baseUrlPlaceholder,
    defaultBaseUrl,
    showBaseUrl = true,
    options,
    value,
    onChange,
    autoSelectFirst = true
}): ReactNode => {
    const { t } = useI18n()
    const filtered = useMemo(
        () =>
            options
                .filter((o) => providerSupportsTarget(o, provider))
                // Managed channels an admin switched off stay usable for agents
                // already bound to them, but must not be picked for new ones.
                .filter((o) => !o.channelDisabled)
                .filter((o) => {
                    // Hide providers whose wire protocol the agent framework
                    // can't actually talk — e.g. codex only speaks the OpenAI
                    // /v1/responses API, so chat-completions-only providers
                    // (OpenRouter etc.) must not appear. Mirrors the
                    // assertProtocol() narrowing in the API resolver so we
                    // fail at picker time, not after agent create.
                    if (!framework) return true
                    const protocol = providerProtocolForTarget(o, provider)
                    if (!protocol) return true
                    return frameworkSupportsProtocol(framework, protocol)
                })
                .filter((o) => {
                    // Hide managed Anthropic for openclaw / hermes — those
                    // frameworks send tool-rich requests that hit Claude.ai's
                    // "third-party app extra usage" rate limit on the shared
                    // managed account. BYO Anthropic stays available.
                    if (!framework || !o.inferenceProtocol) return true
                    return isManagedProtocolAllowedForFramework(
                        framework,
                        o.source,
                        o.inferenceProtocol
                    )
                })
                .sort((a, b) => {
                    const sourceDelta =
                        (a.source === 'managed' ? 0 : 1) -
                        (b.source === 'managed' ? 0 : 1)
                    if (sourceDelta !== 0) return sourceDelta
                    return a.providerName.localeCompare(b.providerName)
                }),
        [options, provider, framework]
    )

    useEffect(() => {
        const selectedExists = filtered.some((o) => o.id === value.providerId)
        if (filtered.length === 0 && value.mode === 'saved') {
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
    }, [autoSelectFirst, filtered, onChange, value])

    return (
        <div className='space-y-3'>
            <div>
                <span className='workbench-field-label'>
                    {label ?? t('web.agentNew.provider')}
                </span>
                <div className='grid gap-2'>
                    {filtered.map((o) => {
                        const selected =
                            value.mode === 'saved' && value.providerId === o.id
                        return (
                            <button
                                key={o.id}
                                type='button'
                                onClick={() =>
                                    onChange({
                                        ...value,
                                        mode: 'saved',
                                        providerId: o.id
                                    })
                                }
                                className={[
                                    'shadow-ring-light flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3.5 py-3 text-left transition-colors',
                                    selected
                                        ? 'text-fg shadow-card bg-info-bg'
                                        : 'text-muted hover:text-fg bg-surface hover:bg-surface-hover'
                                ].join(' ')}
                            >
                                <span className='min-w-0'>
                                    <span className='text-ui flex items-center gap-2 truncate font-medium'>
                                        <span className='truncate'>
                                            {o.providerName}
                                        </span>
                                        <span className='tag tag-neutral'>
                                            {(() => {
                                                const brand = brandFor(o)
                                                return brand
                                                    ? providerLabel[brand]
                                                    : t('web.agentNew.customProvider')
                                            })()}
                                        </span>
                                        {o.source === 'managed' && (
                                            <span className='tag tag-neutral'>
                                                {t('web.agentNew.managed')}
                                            </span>
                                        )}
                                    </span>
                                    <span className='text-caption text-subtle block truncate'>
                                        {o.apiKeyMasked}
                                    </span>
                                </span>
                                <span
                                    className={[
                                        'shadow-ring-light h-3 w-3 shrink-0 rounded-full',
                                        selected ? 'bg-link' : 'bg-white'
                                    ].join(' ')}
                                />
                            </button>
                        )
                    })}
                    <button
                        type='button'
                        onClick={() =>
                            onChange({
                                ...value,
                                mode: 'inline',
                                providerId: ''
                            })
                        }
                        className={[
                            'shadow-ring-light flex min-h-12 w-full items-center justify-between gap-3 rounded-md px-3.5 py-3 text-left transition-colors',
                            value.mode === 'inline'
                                ? 'text-fg shadow-card bg-info-bg'
                                : 'text-muted hover:text-fg bg-surface hover:bg-surface-hover'
                        ].join(' ')}
                    >
                        <span>
                            <span className='text-ui block font-medium'>
                                {t('web.agentNew.useNewApiKey')}
                            </span>
                            <span className='text-caption text-subtle block'>
                                {t('web.agentNew.provideCredentials')}
                            </span>
                        </span>
                        <span
                            className={[
                                'shadow-ring-light h-3 w-3 shrink-0 rounded-full',
                                value.mode === 'inline' ? 'bg-link' : 'bg-white'
                            ].join(' ')}
                        />
                    </button>
                </div>
                {filtered.length === 0 && (
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

            {value.mode === 'inline' && (
                <div className='shadow-ring-light space-y-4 rounded-md bg-[#f8f8f5] p-4'>
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
                                    {t('web.agentNew.leaveBlankOfficialEndpoint')}{' '}
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
                                placeholder={t('web.agentNew.keyLabelPlaceholder')}
                                className='workbench-input'
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
