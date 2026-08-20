import { apiPaths } from '@manyfold/shared'

export const a2aEndpointUrls = (
    agentId: string,
    apiOrigin: string
): { cardUrl: string; rpcUrl: string } => ({
    cardUrl: `${apiOrigin}${apiPaths.A2A_AGENT_CARD(agentId)}`,
    rpcUrl: `${apiOrigin}/a2a/agents/${agentId}/rpc`
})
