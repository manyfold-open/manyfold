import type { FC, ReactNode } from 'react'
import {
    runtimeAuthSupported,
    type AgentFramework,
    type AgentModelConfigView,
    type AgentRuntime
} from '@manyfold/shared'
import { Link } from 'react-router-dom'
import RuntimeAuthProfileSelect from '@/components/chat/RuntimeAuthProfileSelect'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import {
    INHERITED_AUTH_OPTION,
    profilesWithBinding,
    runtimeAuthPickerState
} from '@/lib/runtimeAuth'
import { useRuntimeAuthBinding } from '@/lib/useRuntimeAuthBinding'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'

// The agent's "run under which account" row on the Model provider tab, shown
// under the source switch while the source is the runtime's own CLI. The
// write itself (CAS + conflict recovery) is the shared binding hook, so this
// row and the composer's local-config panel cannot drift.
const RuntimeAuthBindingRow: FC<{
    agentId: string
    runtimeId: string
    framework: AgentFramework
    runtimeKind: AgentRuntime
    view: AgentModelConfigView
    onView: (view: AgentModelConfigView) => void
}> = ({
    agentId,
    runtimeId,
    framework,
    runtimeKind,
    view,
    onView
}): ReactNode => {
    const { t } = useI18n()
    const supported = runtimeAuthSupported(framework, runtimeKind)
    const { list, reload } = useRuntimeAuthList(supported ? runtimeId : null)
    const { saving, error, change } = useRuntimeAuthBinding(
        agentId,
        view,
        onView
    )
    const picker = runtimeAuthPickerState(list)
    const bound = view.runtimeAuth.profileId
    if (!supported || (picker === 'hidden' && !bound)) return null
    const profiles = profilesWithBinding(list, view.runtimeAuth)

    return (
        <div className='space-y-1.5 pt-1'>
            <div className='flex items-center gap-2'>
                <span className='text-caption text-subtle'>
                    {t('web.runtimeAuth.accountLabel')}
                </span>
                <RuntimeAuthProfileSelect
                    profiles={profiles}
                    value={bound ?? INHERITED_AUTH_OPTION}
                    onChange={(next): void => {
                        void change(next).then((ok) => {
                            if (!ok) void reload()
                        })
                    }}
                    disabled={saving || picker === 'execute-unsupported'}
                    size='sm'
                />
                {saving && <Spinner size={12} />}
            </div>
            <p className='text-caption text-subtle'>
                {picker === 'execute-unsupported'
                    ? t('web.runtimeAuth.executeUnsupported')
                    : t('web.runtimeAuth.settingsHint')}{' '}
                <Link
                    to={`/settings/runtimes/${runtimeId}`}
                    className='text-link hover:text-fg font-medium'
                >
                    {t('web.runtimeAuth.runtimePageLink')}
                </Link>
            </p>
            {error && <div className='text-caption text-error'>{error}</div>}
        </div>
    )
}

export default RuntimeAuthBindingRow
