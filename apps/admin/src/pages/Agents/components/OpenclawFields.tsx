import type { OpenclawModelProvider } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type { OpenclawFieldsValue } from './OpenclawFields.helpers'

const radioCardClass = (active: boolean): string =>
    [
        'flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-body text-heading transition-colors',
        active
            ? 'border-brand bg-brand-subtle'
            : 'border-border bg-white hover:border-brand-light'
    ].join(' ')

const providers: Array<{ value: OpenclawModelProvider; labelKey: string }> = [
    {
        value: 'anthropic',
        labelKey: 'admin.agents.new.openclawProviderAnthropic'
    },
    { value: 'openai', labelKey: 'admin.agents.new.openclawProviderOpenai' },
    {
        value: 'openrouter',
        labelKey: 'admin.agents.new.openclawProviderOpenrouter'
    }
]

interface Props {
    value: OpenclawFieldsValue
    onChange: (next: OpenclawFieldsValue) => void
}

export const OpenclawFields: FC<Props> = ({ value, onChange }): ReactNode => (
    <div className='space-y-2'>
        <div>
            <span className='text-caption text-label mb-1 block font-normal'>
                {t('admin.agents.new.openclawProviderLabel')}
            </span>
            <div className='grid grid-cols-3 gap-3'>
                {providers.map((p) => (
                    <label
                        key={p.value}
                        className={radioCardClass(
                            value.modelProvider === p.value
                        )}
                    >
                        <input
                            type='radio'
                            name='openclawProvider'
                            value={p.value}
                            checked={value.modelProvider === p.value}
                            onChange={() =>
                                onChange({ ...value, modelProvider: p.value })
                            }
                            className='accent-brand'
                        />
                        {t(p.labelKey)}
                    </label>
                ))}
            </div>
        </div>
        <Input
            id='openclawApiKey'
            type='password'
            label={t('admin.agents.new.openclawApiKeyLabel')}
            hint={t('admin.agents.new.openclawApiKeyHint')}
            required
            minLength={10}
            maxLength={1024}
            value={value.apiKey}
            onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
            autoComplete='off'
        />
        <Input
            id='openclawModelName'
            type='text'
            label={t('admin.agents.new.openclawModelNameLabel')}
            hint={t('admin.agents.new.openclawModelNameHint')}
            required
            minLength={1}
            maxLength={255}
            value={value.primaryModelName}
            onChange={(e) =>
                onChange({ ...value, primaryModelName: e.target.value })
            }
            autoComplete='off'
        />
        <Input
            id='openclawBaseUrl'
            type='url'
            label={t('admin.agents.new.openclawBaseUrlLabel')}
            maxLength={512}
            value={value.baseUrl}
            onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
        />
    </div>
)
