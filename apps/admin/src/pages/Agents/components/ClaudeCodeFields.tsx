import type { FC, ReactNode } from 'react'
import { t } from '@manyfold/i18n'
import { Input } from '@/ui'
import type { ClaudeCodeFieldsValue } from './ClaudeCodeFields.helpers'

interface Props {
    value: ClaudeCodeFieldsValue
    onChange: (next: ClaudeCodeFieldsValue) => void
}

export const ClaudeCodeFields: FC<Props> = ({ value, onChange }): ReactNode => (
    <div className='space-y-2'>
        <Input
            id='anthropicAuthToken'
            type='password'
            label={t('admin.agents.new.claudeCodeTokenLabel')}
            hint={t('admin.agents.new.claudeCodeTokenHint')}
            required
            minLength={10}
            maxLength={1024}
            value={value.anthropicAuthToken}
            onChange={(e) =>
                onChange({ ...value, anthropicAuthToken: e.target.value })
            }
            autoComplete='off'
        />
        <Input
            id='anthropicBaseUrl'
            type='url'
            label={t('admin.agents.new.claudeCodeBaseUrlLabel')}
            maxLength={512}
            value={value.anthropicBaseUrl}
            onChange={(e) =>
                onChange({ ...value, anthropicBaseUrl: e.target.value })
            }
        />
    </div>
)
