import type { FC, ReactNode } from 'react'
import { Input } from '@/ui'
import type { GeminiCliFieldsValue } from './GeminiCliFields.helpers'

interface Props {
    value: GeminiCliFieldsValue
    onChange: (next: GeminiCliFieldsValue) => void
}

export const GeminiCliFields: FC<Props> = ({ value, onChange }): ReactNode => (
    <div className='space-y-2'>
        <Input
            id='googleApiKey'
            type='password'
            label='Gemini API key'
            hint='Google AI Studio API key used by Gemini CLI.'
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
            id='googleGeminiBaseUrl'
            type='url'
            label='Gemini base URL (optional)'
            hint='Override GOOGLE_GEMINI_BASE_URL. Leave blank to use the Netmind proxy.'
            maxLength={512}
            value={value.googleGeminiBaseUrl}
            onChange={(e) =>
                onChange({ ...value, googleGeminiBaseUrl: e.target.value })
            }
        />
    </div>
)
