import { AGY_API_KEY_MODELS } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type { AntigravityCliFieldsValue } from './AntigravityCliFields.helpers'

interface Props {
    value: AntigravityCliFieldsValue
    onChange: (next: AntigravityCliFieldsValue) => void
}

export const AntigravityCliFields: FC<Props> = ({
    value,
    onChange
}): ReactNode => (
    <div className='space-y-2'>
        <Input
            id='antigravityApiKey'
            type='password'
            label={t('admin.agents.new.antigravityApiKeyLabel')}
            hint={t('admin.agents.new.antigravityApiKeyHint')}
            required
            minLength={10}
            maxLength={1024}
            value={value.googleApiKey}
            onChange={(e) =>
                onChange({ ...value, googleApiKey: e.target.value })
            }
            autoComplete='off'
        />
        <Input
            id='antigravityBaseUrl'
            type='url'
            label={t('admin.agents.new.antigravityBaseUrlLabel')}
            hint={t('admin.agents.new.antigravityBaseUrlHint')}
            maxLength={512}
            value={value.googleGeminiBaseUrl}
            onChange={(e) =>
                onChange({ ...value, googleGeminiBaseUrl: e.target.value })
            }
        />
        <div>
            <label
                htmlFor='antigravityModel'
                className='text-caption text-label mb-1 block font-normal'
            >
                {t('admin.agents.new.antigravityModelLabel')}
            </label>
            <select
                id='antigravityModel'
                className='border-border text-body text-heading focus:border-brand focus:ring-brand block h-10 w-full rounded border bg-white px-3 focus:outline-none focus:ring-1'
                value={value.model}
                onChange={(e) => onChange({ ...value, model: e.target.value })}
            >
                <option value=''>
                    {t('admin.agents.new.antigravityModelDefault')}
                </option>
                {AGY_API_KEY_MODELS.map((model) => (
                    <option key={model.slug} value={model.slug}>
                        {model.slug}
                    </option>
                ))}
            </select>
        </div>
    </div>
)
