import { useState } from 'react'
import { RUNTIME_AUTH_ERROR, type AgentModelConfigView } from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import {
    mergeCachedRuntimeLocalModelConfigView,
    readCachedModelConfigView,
    writeCachedModelConfigView
} from '@/lib/agentModelConfig'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

// The agent's "run under which account" write, shared by the settings row and
// the composer's local-config panel. A change persists at once as a
// compare-and-set on the binding version, so two surfaces editing the same
// agent cannot silently overwrite each other; the loser sees the conflict and
// the reloaded value. Returned views merge against the local cache like every
// load path does, so a response carrying a staler runtime-local status cannot
// flip a local-config panel the user has open.
export const useRuntimeAuthBinding = (
    agentId: string,
    view: AgentModelConfigView,
    onView: (view: AgentModelConfigView) => void
): {
    saving: boolean
    error: string | null
    change: (profileId: string) => Promise<boolean>
} => {
    const { t } = useI18n()
    const client = useApiClient()
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const apply = (next: AgentModelConfigView): void => {
        const merged = mergeCachedRuntimeLocalModelConfigView(
            next,
            readCachedModelConfigView(agentId)
        )
        writeCachedModelConfigView(merged)
        onView(merged)
    }

    const change = async (profileId: string): Promise<boolean> => {
        const next = profileId || null
        if (next === view.runtimeAuth.profileId || saving) return true
        setSaving(true)
        setError(null)
        try {
            apply(
                await client.agents.updateRuntimeAuth(agentId, {
                    profileId: next,
                    expectedBindingVersion: view.runtimeAuth.bindingVersion
                })
            )
            return true
        } catch (err) {
            if (
                err instanceof ApiError &&
                err.code === RUNTIME_AUTH_ERROR.bindingConflict
            ) {
                setError(t('web.runtimeAuth.bindingConflict'))
                try {
                    apply(await client.agents.getModelConfig(agentId))
                } catch {}
            } else setError(apiErrorMessage(err))
            return false
        } finally {
            setSaving(false)
        }
    }

    return { saving, error, change }
}
