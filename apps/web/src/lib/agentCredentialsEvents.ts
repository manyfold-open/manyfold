import type { AgentCredentialsView } from '@manyfold/shared'

export const agentCredentialsUpdatedEvent = 'nca.agentCredentials.updated'

export const agentCredentialsOpenEvent = 'nca.agentCredentials.open'

export const publishAgentCredentialsOpen = (agentId: string): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
        new CustomEvent<{ agentId: string }>(agentCredentialsOpenEvent, {
            detail: { agentId }
        })
    )
}

export const subscribeAgentCredentialsOpen = (
    onOpen: (agentId: string) => void
): (() => void) => {
    if (typeof window === 'undefined') return () => {}
    const handleOpen = (event: Event): void => {
        const detail = (event as CustomEvent<{ agentId: string }>).detail
        if (!detail?.agentId) return
        onOpen(detail.agentId)
    }
    window.addEventListener(agentCredentialsOpenEvent, handleOpen)
    return () => {
        window.removeEventListener(agentCredentialsOpenEvent, handleOpen)
    }
}

export interface AgentCredentialsUpdatedDetail {
    agentId: string
    view: AgentCredentialsView
}

export const publishAgentCredentialsUpdated = (
    agentId: string,
    view: AgentCredentialsView
): void => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
        new CustomEvent<AgentCredentialsUpdatedDetail>(
            agentCredentialsUpdatedEvent,
            {
                detail: {
                    agentId,
                    view
                }
            }
        )
    )
}

export const subscribeAgentCredentialsUpdates = (
    agentId: string,
    onUpdate: (view: AgentCredentialsView) => void
): (() => void) => {
    if (typeof window === 'undefined') return () => {}
    const handleUpdate = (event: Event): void => {
        const detail = (event as CustomEvent<AgentCredentialsUpdatedDetail>)
            .detail
        if (detail?.agentId !== agentId) return
        onUpdate(detail.view)
    }
    window.addEventListener(agentCredentialsUpdatedEvent, handleUpdate)
    return () => {
        window.removeEventListener(agentCredentialsUpdatedEvent, handleUpdate)
    }
}
