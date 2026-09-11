import type { PiProvider } from '@manyfold/shared'
import { PI_PROVIDERS } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type { PiFieldsValue } from './PiFields.helpers'

const radioCardClass = (active: boolean): string =>
    [
        'flex cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-body text-heading transition-colors',
        active
            ? 'border-brand bg-brand-subtle'
            : 'border-border bg-white hover:border-brand-light'
    ].join(' ')

const providerLabelKey: Record<PiProvider, string> = {
    anthropic: 'admin.agents.new.piProviderAnthropic',
    openai: 'admin.agents.new.piProviderOpenai',
    google: 'admin.agents.new.piProviderGoogle'
}

interface Props {
    value: PiFieldsValue
    onChange: (next: PiFieldsValue) => void
}

export const PiFields: FC<Props> = ({ value, onChange }): ReactNode => (
    <div className='space-y-2'>
        <div>
            <span className='text-caption text-label mb-1 block font-normal'>
                {t('admin.agents.new.piProviderLabel')}
            </span>
            <div className='grid grid-cols-3 gap-3'>
                {PI_PROVIDERS.map((provider) => (
                    <label
                        key={provider}
                        className={radioCardClass(value.provider === provider)}
                    >
                        <input
                            type='radio'
                            name='piProvider'
                            value={provider}
                            checked={value.provider === provider}
                            onChange={() => onChange({ ...value, provider })}
                            className='accent-brand'
                        />
                        {t(providerLabelKey[provider])}
                    </label>
                ))}
            </div>
        </div>
        <Input
            id='piApiKey'
            type='password'
            label={t('admin.agents.new.piApiKeyLabel')}
            hint={t('admin.agents.new.piApiKeyHint')}
            required
            minLength={10}
            maxLength={1024}
            value={value.apiKey}
            onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
            autoComplete='off'
        />
        <Input
            id='piBaseUrl'
            type='url'
            label={t('admin.agents.new.piBaseUrlLabel')}
            hint={t('admin.agents.new.piBaseUrlHint')}
            maxLength={512}
            value={value.baseUrl}
            onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
        />
        <Input
            id='piModel'
            type='text'
            label={t('admin.agents.new.piModelLabel')}
            hint={t('admin.agents.new.piModelHint')}
            maxLength={255}
            value={value.model}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
    </div>
)
