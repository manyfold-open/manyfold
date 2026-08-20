import type { HermesModelProvider } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type {
    HermesEmailPlatformState,
    HermesFieldsValue,
    HermesMatrixPlatformState,
    HermesTokenPlatformState
} from './HermesFields.helpers'

const radioCardClass = (active: boolean): string =>
    [
        'flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-body text-heading transition-colors',
        active
            ? 'border-brand bg-brand-subtle'
            : 'border-border bg-white hover:border-brand-light'
    ].join(' ')

const toggleRowClass =
    'flex cursor-pointer items-center gap-2 rounded border border-border bg-white px-3 py-2 text-body text-heading transition-colors hover:border-brand-light'

const providers: Array<{ value: HermesModelProvider; labelKey: string }> = [
    {
        value: 'openrouter',
        labelKey: 'admin.agents.new.hermesPrimaryProviderOpenrouter'
    },
    {
        value: 'anthropic',
        labelKey: 'admin.agents.new.hermesPrimaryProviderAnthropic'
    },
    {
        value: 'openai',
        labelKey: 'admin.agents.new.hermesPrimaryProviderOpenai'
    }
]

type TokenPlatformKey =
    | 'telegram'
    | 'discord'
    | 'slack'
    | 'whatsapp'
    | 'signal'
    | 'homeAssistant'

const tokenPlatforms: Array<{
    key: TokenPlatformKey
    labelKey: string
    inputId: string
}> = [
    {
        key: 'telegram',
        labelKey: 'admin.agents.new.hermesPlatformTelegram',
        inputId: 'hermesTelegramToken'
    },
    {
        key: 'discord',
        labelKey: 'admin.agents.new.hermesPlatformDiscord',
        inputId: 'hermesDiscordToken'
    },
    {
        key: 'slack',
        labelKey: 'admin.agents.new.hermesPlatformSlack',
        inputId: 'hermesSlackToken'
    },
    {
        key: 'whatsapp',
        labelKey: 'admin.agents.new.hermesPlatformWhatsapp',
        inputId: 'hermesWhatsappToken'
    },
    {
        key: 'signal',
        labelKey: 'admin.agents.new.hermesPlatformSignal',
        inputId: 'hermesSignalToken'
    },
    {
        key: 'homeAssistant',
        labelKey: 'admin.agents.new.hermesPlatformHomeAssistant',
        inputId: 'hermesHomeAssistantToken'
    }
]

interface Props {
    value: HermesFieldsValue
    onChange: (next: HermesFieldsValue) => void
}

export const HermesFields: FC<Props> = ({ value, onChange }): ReactNode => {
    const setToken = (
        key: TokenPlatformKey,
        next: Partial<HermesTokenPlatformState>
    ): void => {
        onChange({ ...value, [key]: { ...value[key], ...next } })
    }
    const setEmail = (next: Partial<HermesEmailPlatformState>): void => {
        onChange({ ...value, email: { ...value.email, ...next } })
    }
    const setMatrix = (next: Partial<HermesMatrixPlatformState>): void => {
        onChange({ ...value, matrix: { ...value.matrix, ...next } })
    }

    return (
        <div className='space-y-8'>
            <section className='space-y-2'>
                <h3 className='text-body text-heading font-normal'>
                    {t('admin.agents.new.hermesPrimaryModelSection')}
                </h3>
                <div>
                    <span className='text-caption text-label mb-1 block font-normal'>
                        {t('admin.agents.new.hermesPrimaryProviderLabel')}
                    </span>
                    <div className='grid grid-cols-3 gap-3'>
                        {providers.map((p) => (
                            <label
                                key={p.value}
                                className={radioCardClass(
                                    value.primaryProvider === p.value
                                )}
                            >
                                <input
                                    type='radio'
                                    name='hermesPrimaryProvider'
                                    value={p.value}
                                    checked={value.primaryProvider === p.value}
                                    onChange={() =>
                                        onChange({
                                            ...value,
                                            primaryProvider: p.value
                                        })
                                    }
                                    className='accent-brand'
                                />
                                {t(p.labelKey)}
                            </label>
                        ))}
                    </div>
                </div>
                <Input
                    id='hermesPrimaryApiKey'
                    type='password'
                    label={t('admin.agents.new.hermesPrimaryApiKeyLabel')}
                    hint={t('admin.agents.new.hermesPrimaryApiKeyHint')}
                    required
                    minLength={10}
                    maxLength={1024}
                    value={value.primaryApiKey}
                    onChange={(e) =>
                        onChange({ ...value, primaryApiKey: e.target.value })
                    }
                    autoComplete='off'
                />
                <Input
                    id='hermesPrimaryModelName'
                    type='text'
                    label={t('admin.agents.new.hermesPrimaryModelNameLabel')}
                    hint={t('admin.agents.new.hermesPrimaryModelNameHint')}
                    maxLength={255}
                    value={value.primaryModelName}
                    onChange={(e) =>
                        onChange({ ...value, primaryModelName: e.target.value })
                    }
                />
                <Input
                    id='hermesPrimaryBaseUrl'
                    type='url'
                    label={t('admin.agents.new.hermesPrimaryBaseUrlLabel')}
                    maxLength={512}
                    value={value.primaryBaseUrl}
                    onChange={(e) =>
                        onChange({ ...value, primaryBaseUrl: e.target.value })
                    }
                />
            </section>

            <section className='space-y-2'>
                <div>
                    <h3 className='text-body text-heading font-normal'>
                        {t('admin.agents.new.hermesPlatformsSection')}
                    </h3>
                    <p className='text-caption-sm text-body mt-1'>
                        {t('admin.agents.new.hermesPlatformsHint')}
                    </p>
                </div>
                <div className='space-y-3'>
                    {tokenPlatforms.map((p) => {
                        const state = value[p.key]
                        return (
                            <div key={p.key} className='space-y-3'>
                                <label className={toggleRowClass}>
                                    <input
                                        type='checkbox'
                                        checked={state.enabled}
                                        onChange={(e) =>
                                            setToken(p.key, {
                                                enabled: e.target.checked
                                            })
                                        }
                                        className='accent-brand'
                                    />
                                    {t(p.labelKey)}
                                </label>
                                {state.enabled && (
                                    <div className='pl-6'>
                                        <Input
                                            id={p.inputId}
                                            type='password'
                                            label={t(
                                                'admin.agents.new.hermesTokenLabel'
                                            )}
                                            required
                                            minLength={10}
                                            maxLength={1024}
                                            value={state.token}
                                            onChange={(e) =>
                                                setToken(p.key, {
                                                    token: e.target.value
                                                })
                                            }
                                            autoComplete='off'
                                        />
                                    </div>
                                )}
                            </div>
                        )
                    })}
                    <div className='space-y-3'>
                        <label className={toggleRowClass}>
                            <input
                                type='checkbox'
                                checked={value.matrix.enabled}
                                onChange={(e) =>
                                    setMatrix({ enabled: e.target.checked })
                                }
                                className='accent-brand'
                            />
                            {t('admin.agents.new.hermesPlatformMatrix')}
                        </label>
                        {value.matrix.enabled && (
                            <div className='grid grid-cols-2 gap-2 pl-6'>
                                <Input
                                    id='hermesMatrixHomeserver'
                                    type='url'
                                    label={t(
                                        'admin.agents.new.hermesMatrixHomeserverLabel'
                                    )}
                                    required
                                    minLength={1}
                                    maxLength={512}
                                    value={value.matrix.homeserver}
                                    onChange={(e) =>
                                        setMatrix({
                                            homeserver: e.target.value
                                        })
                                    }
                                />
                                <Input
                                    id='hermesMatrixAccessToken'
                                    type='password'
                                    label={t(
                                        'admin.agents.new.hermesMatrixAccessTokenLabel'
                                    )}
                                    required
                                    minLength={10}
                                    maxLength={1024}
                                    value={value.matrix.accessToken}
                                    onChange={(e) =>
                                        setMatrix({
                                            accessToken: e.target.value
                                        })
                                    }
                                    autoComplete='off'
                                />
                            </div>
                        )}
                    </div>
                    <div className='space-y-3'>
                        <label className={toggleRowClass}>
                            <input
                                type='checkbox'
                                checked={value.email.enabled}
                                onChange={(e) =>
                                    setEmail({ enabled: e.target.checked })
                                }
                                className='accent-brand'
                            />
                            {t('admin.agents.new.hermesPlatformEmail')}
                        </label>
                        {value.email.enabled && (
                            <div className='grid grid-cols-2 gap-2 pl-6'>
                                <Input
                                    id='hermesEmailHost'
                                    type='text'
                                    label={t(
                                        'admin.agents.new.hermesEmailHostLabel'
                                    )}
                                    required
                                    minLength={1}
                                    maxLength={255}
                                    value={value.email.host}
                                    onChange={(e) =>
                                        setEmail({ host: e.target.value })
                                    }
                                />
                                <Input
                                    id='hermesEmailPort'
                                    type='number'
                                    label={t(
                                        'admin.agents.new.hermesEmailPortLabel'
                                    )}
                                    required
                                    min={1}
                                    max={65535}
                                    value={value.email.port}
                                    onChange={(e) =>
                                        setEmail({ port: e.target.value })
                                    }
                                />
                                <Input
                                    id='hermesEmailUser'
                                    type='text'
                                    label={t(
                                        'admin.agents.new.hermesEmailUserLabel'
                                    )}
                                    required
                                    minLength={1}
                                    maxLength={255}
                                    value={value.email.user}
                                    onChange={(e) =>
                                        setEmail({ user: e.target.value })
                                    }
                                    autoComplete='off'
                                />
                                <Input
                                    id='hermesEmailPassword'
                                    type='password'
                                    label={t(
                                        'admin.agents.new.hermesEmailPasswordLabel'
                                    )}
                                    required
                                    minLength={1}
                                    maxLength={1024}
                                    value={value.email.password}
                                    onChange={(e) =>
                                        setEmail({ password: e.target.value })
                                    }
                                    autoComplete='off'
                                />
                            </div>
                        )}
                    </div>
                </div>
            </section>

            <Input
                id='hermesProfile'
                type='text'
                label={t('admin.agents.new.hermesProfileLabel')}
                hint={t('admin.agents.new.hermesProfileHint')}
                maxLength={64}
                value={value.profile}
                onChange={(e) =>
                    onChange({ ...value, profile: e.target.value })
                }
            />
        </div>
    )
}
