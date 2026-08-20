import type { PermissionConsentPreview } from '@manyfold/shared'

// The permission card lives in chat history, so it outlives its own React
// state: a new turn refetches the message list and remounts it, and a reload
// rebuilds it from scratch. Its resolved state therefore comes from the
// request's server-side row, not from having witnessed the click.
export type CardState =
    | { kind: 'loading' }
    | { kind: 'pending'; preview: PermissionConsentPreview | null }
    | { kind: 'approved'; agentName: string; count: number }
    | { kind: 'denied' }
    | { kind: 'unavailable' }

export const stateFromPreview = (
    preview: PermissionConsentPreview
): CardState => {
    if (preview.status === 'approved')
        return {
            kind: 'approved',
            agentName: preview.agentName,
            count: preview.approvedScopes.length
        }
    if (preview.status === 'denied') return { kind: 'denied' }
    return { kind: 'pending', preview }
}
