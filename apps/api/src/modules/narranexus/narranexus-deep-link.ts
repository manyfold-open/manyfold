import { agentBaseUrl } from '@manyfold/shared'
import { manyfoldUserToNarraNexusUserId } from './narranexus-paths'

// Manyfold ↔ NarraNexus dashboard handoff format. Bump when the fragment
// schema changes incompatibly so NarraNexus can refuse to interpret it.
// Tracked in repos/manyfold/docs (TODO once written) — keep in sync with
// NarraNexus backend's fragment parser.
export const NARRANEXUS_DEEP_LINK_VERSION = '1'

export interface NarraNexusDeepLinkInput {
    ingressHost: string
    gatewayToken: string
    manyfoldUserId: string
    agentInternalId?: string | null
}

export const buildNarraNexusDeepLink = (
    input: NarraNexusDeepLinkInput
): string => {
    const params: string[] = [
        `v=${NARRANEXUS_DEEP_LINK_VERSION}`,
        `token=${encodeURIComponent(input.gatewayToken)}`,
        `user=${encodeURIComponent(manyfoldUserToNarraNexusUserId(input.manyfoldUserId))}`
    ]
    if (input.agentInternalId)
        params.push(`agent=${encodeURIComponent(input.agentInternalId)}`)
    return agentBaseUrl(input.ingressHost, `/#${params.join('&')}`)
}
