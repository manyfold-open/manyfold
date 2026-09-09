import { useState } from 'react'
import type { FC, ReactNode } from 'react'
import {
    RUNTIME_AUTH_ERROR,
    runtimeAuthSupported,
    type AgentFramework,
    type AgentModelConfigView,
    type AgentRuntime
} from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import { Link } from 'react-router-dom'
import RuntimeAuthProfileSelect from '@/components/chat/RuntimeAuthProfileSelect'
import { Spinner } from '@/components/Loading'
import { writeCachedModelConfigView } from '@/lib/agentModelConfig'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import {
    INHERITED_AUTH_OPTION,
    runtimeAuthPickerState,
    type RuntimeAuthProfileSummary
} from '@/lib/runtimeAuth'
import { useRuntimeAuthList } from '@/lib/useRuntimeAuthList'

// The agent's "run under which account" row on the Model provider tab, shown
// under the source switch while the source is the runtime's own CLI. A
// change persists at once as a compare-and-set on the binding version, so
// two tabs editing the same agent cannot silently overwrite each other; the
// loser sees the conflict and the reloaded value.
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
    const client = useApiClient()
    const supported = runtimeAuthSupported(framework, runtimeKind)
    const { list, reload } = useRuntimeAuthList(supported ? runtimeId : null)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const picker = runtimeAuthPickerState(list)
    const bound = view.runtimeAuth.profileId
    // A bound profile that the list no longer offers (removed elsewhere)
    // still needs a row so the user can see it and move the agent off it.
    if (!supported || (picker === 'hidden' && !bound)) return null
    const profiles: RuntimeAuthProfileSummary[] = [...(list?.profiles ?? [])]
    if (
        bound &&
        view.runtimeAuth.profile &&
        !profiles.some((profile) => profile.id === bound)
    )
        profiles.push(view.runtimeAuth.profile)

    const change = async (profileId: string): Promise<void> => {
        const next = profileId || null
        if (next === bound || saving) return
        setSaving(true)
        setError(null)
        try {
            const updated = await client.agents.updateRuntimeAuth(agentId, {
                profileId: next,
                expectedBindingVersion: view.runtimeAuth.bindingVersion
            })
            writeCachedModelConfigView(updated)
            onView(updated)
        } catch (err) {
            if (
                err instanceof ApiError &&
                err.code === RUNTIME_AUTH_ERROR.bindingConflict
            ) {
                setError(t('web.runtimeAuth.bindingConflict'))
                try {
                    const fresh = await client.agents.getModelConfig(agentId)
                    writeCachedModelConfigView(fresh)
                    onView(fresh)
                } catch {}
            } else setError(apiErrorMessage(err))
            void reload()
        } finally {
            setSaving(false)
        }
    }

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
                        void change(next)
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
