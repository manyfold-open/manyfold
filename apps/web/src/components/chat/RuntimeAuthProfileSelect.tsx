import type { FC, ReactNode } from 'react'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useI18n } from '@/lib/i18n'
import {
    runtimeAuthOptions,
    type RuntimeAuthProfileSummary
} from '@/lib/runtimeAuth'

// The "which account does this agent run under" chooser, shared by the create
// wizard and agent settings. Pure presentation: the caller owns the list, the
// current value and what a change means (a draft field vs a persisted CAS
// update), so the two surfaces cannot drift in how they name the rows.
const RuntimeAuthProfileSelect: FC<{
    profiles: readonly RuntimeAuthProfileSummary[]
    value: string
    onChange: (profileId: string) => void
    disabled?: boolean
    size?: 'md' | 'sm'
}> = ({ profiles, value, onChange, disabled, size }): ReactNode => {
    const { t } = useI18n()
    return (
        <WorkbenchSelect
            ariaLabel={t('web.runtimeAuth.accountLabel')}
            menuClassName='min-w-64'
            value={value}
            onChange={onChange}
            disabled={disabled}
            size={size}
            options={runtimeAuthOptions(profiles, t)}
        />
    )
}

export default RuntimeAuthProfileSelect
