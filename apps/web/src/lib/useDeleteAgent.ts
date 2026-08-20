import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'
import { useProductConfirm } from '@/components/ProductConfirmDialog'

interface UseDeleteAgentOptions {
    // Called after the agent is gone so the caller can refresh its own lists.
    onDeleted?: (agent: SdkAgent) => void
    onError?: (message: string) => void
    // Where to land once the agent is gone, or null to stay put. Deleting the
    // agent you are looking at has to move you; deleting some other row from
    // the rail must not yank you out of the conversation you are in.
    redirectTo?: (agent: SdkAgent) => string | null
}

interface UseDeleteAgentResult {
    deleteAgent: (agent: SdkAgent) => Promise<void>
    deleting: boolean
    confirmDialog: ReactNode
}

// Both agent menus (rail row, settings header) delete through here so the
// confirmation copy, the name-match guard and the post-delete redirect cannot
// drift between the two entry points.
export const useDeleteAgent = (
    options: UseDeleteAgentOptions = {}
): UseDeleteAgentResult => {
    const { onDeleted, onError, redirectTo } = options
    const client = useApiClient()
    const navigate = useNavigate()
    const { t } = useI18n()
    const { confirm, confirmDialog } = useProductConfirm()
    const [deleting, setDeleting] = useState(false)

    const deleteAgent = useCallback(
        async (agent: SdkAgent): Promise<void> => {
            if (deleting) return
            const confirmed = await confirm({
                title: t('web.agents.detail.delete.title'),
                description: t(
                    agent.runtime === 'sprites'
                        ? 'web.agents.detail.delete.confirmNamedSandbox'
                        : 'web.agents.detail.delete.confirmNamed',
                    { name: agent.name }
                ),
                confirmLabel: t('web.agents.detail.delete.button'),
                tone: 'danger',
                requireMatch: agent.name
            })
            if (!confirmed) return
            setDeleting(true)
            try {
                await client.agents.delete(agent.id)
                onDeleted?.(agent)
                const destination = redirectTo?.(agent) ?? null
                if (destination) navigate(destination)
                // Always clear: the caller may outlive the redirect (the app
                // shell is the layout route for both chat and /workspace), and
                // a flag left set there disables Delete on every agent row.
                setDeleting(false)
            } catch (err) {
                onError?.(apiErrorMessage(err))
                setDeleting(false)
            }
        },
        [client, confirm, deleting, navigate, onDeleted, onError, redirectTo, t]
    )

    return { deleteAgent, deleting, confirmDialog }
}
