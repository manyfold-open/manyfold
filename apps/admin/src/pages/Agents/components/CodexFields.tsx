import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type { CodexFieldsValue } from './CodexFields.helpers'

interface Props {
    value: CodexFieldsValue
    onChange: (next: CodexFieldsValue) => void
}

export const CodexFields: FC<Props> = ({ value, onChange }): ReactNode => (
    <div className='space-y-2'>
        <Input
            id='openaiApiKey'
            type='password'
            label={t('admin.agents.new.codexKeyLabel')}
            hint={t('admin.agents.new.codexKeyHint')}
            required
            minLength={10}
            maxLength={1024}
            value={value.openaiApiKey}
            onChange={(e) =>
                onChange({ ...value, openaiApiKey: e.target.value })
            }
            autoComplete='off'
        />
        <Input
            id='openaiBaseUrl'
            type='url'
            label={t('admin.agents.new.codexBaseUrlLabel')}
            maxLength={512}
            value={value.openaiBaseUrl}
            onChange={(e) =>
                onChange({ ...value, openaiBaseUrl: e.target.value })
            }
        />
    </div>
)
