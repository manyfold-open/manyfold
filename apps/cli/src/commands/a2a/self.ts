import {
    apiPaths,
    type A2aGrantSummary,
    type A2aSelfCallerAddResponse,
    type A2aSelfExposure,
    type A2aSelfPeer,
    type A2aSelfPeerToken,
    type A2aTaskTracePage,
    type AddA2aSelfCallerBody
} from '@manyfold/shared'
import { ApiError, buildApiError } from '@manyfold/sdk'
import { buildClient } from '@/client'
import { findSelfPeer } from '@/commands/a2a/helpers'
import { createCliFetch } from '@/transport'

export interface GlobalAuthOpts {
    apiUrl?: string
    token?: string
    // From the global `--agent-id` / $MF_AGENT_ID. Sent so a human (`mf login`)
    // token can act as one of its own agents; ignored when the token is already
    // an agent runtime (its bound identity is authoritative server-side).
    agentId?: string
}

// Raised when A2A can't resolve a usable identity for this token: an agent
// runtime missing the a2a:read scope, or a human token without an agent
// context. The message covers both so either caller knows the next step.
export class A2aSelfAuthError extends ApiError {
    constructor(
        cause?: ApiError,
        requiredScope: 'a2a:read' | 'a2a:edit' = 'a2a:read'
    ) {
        super({
            status: cause?.status ?? 401,
            statusText: cause?.statusText ?? 'Unauthorized',
            code: cause?.code ?? 'unauthorized',
            message:
                'cannot use A2A with this token.\n' +
                `- Agent runtime: not logged in, or missing the ${requiredScope} scope. Run:\n` +
                `    mf auth ensure --scopes ${requiredScope}\n` +
                '  post exactly the consent URL it prints, then retry after the user approves.\n' +
                '- User (mf login): pass an agent you own via --agent-id <id>, e.g.\n' +
                '    mf --agent-id <id> a2a status',
            body: cause?.body ?? '',
            details: cause?.details
        })
        this.name = 'A2aSelfAuthError'
    }
}

const agentSelfRequest = async <T>(
    global: GlobalAuthOpts,
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    requiredScope: 'a2a:read' | 'a2a:edit' = 'a2a:read',
    body?: unknown
): Promise<T> => {
    const { ctx } = await buildClient(global)
    if (!ctx.token) throw new A2aSelfAuthError(undefined, requiredScope)
    const url = new URL(`${ctx.apiUrl}${path}`)
    if (global.agentId) url.searchParams.set('agentId', global.agentId)
    const headers: Record<string, string> = {
        authorization: `Bearer ${ctx.token}`,
        accept: 'application/json'
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await createCliFetch()(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    // 401/403 → no usable identity (missing scope, or human without an agent
    // context): the onboarding error covers both. Other failures (e.g. 404 for
    // an agentId the user doesn't own) surface the server's own message.
    if (!res.ok) {
        const error = await buildApiError(res)
        if (res.status === 401 || res.status === 403)
            throw new A2aSelfAuthError(error, requiredScope)
        throw error
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
}

// The peers this agent may call right now — resolved live from active grants +
// target exposure. No bearer in the response; mint one per call below.
export const fetchSelfPeers = (
    global: GlobalAuthOpts
): Promise<A2aSelfPeer[]> =>
    agentSelfRequest<A2aSelfPeer[]>(global, '/agent-self/a2a/peers', 'GET')

// This agent's own outbound A2A calls (it was the caller), newest first. Used
// by `mf a2a status` and `mf a2a tasks list` so an async caller can see in-flight
// delegations and fetch durable results after a sprite sleep. No bearer in/out —
// the agent's own login token authorizes; results live in the platform DB.
export const fetchSelfTasks = (
    global: GlobalAuthOpts,
    opts: { state?: string; peer?: string } = {}
): Promise<A2aTaskTracePage> => {
    const params = new URLSearchParams()
    if (opts.state) params.set('state', opts.state)
    if (opts.peer) params.set('peer', opts.peer)
    const qs = params.toString()
    return agentSelfRequest<A2aTaskTracePage>(
        global,
        `/agent-self/a2a/tasks${qs ? `?${qs}` : ''}`,
        'GET'
    )
}

// A fresh short-lived bearer for one granted peer, minted right before the call.
export const mintSelfPeerToken = (
    global: GlobalAuthOpts,
    targetAgentId: string
): Promise<A2aSelfPeerToken> =>
    agentSelfRequest<A2aSelfPeerToken>(
        global,
        `/agent-self/a2a/peers/${encodeURIComponent(targetAgentId)}/token`,
        'POST'
    )

export const fetchSelfExposure = (
    global: GlobalAuthOpts
): Promise<A2aSelfExposure> =>
    agentSelfRequest<A2aSelfExposure>(
        global,
        apiPaths.AGENT_SELF_A2A_EXPOSURE,
        'GET'
    )

export const setSelfExposure = (
    global: GlobalAuthOpts,
    enabled: boolean
): Promise<A2aSelfExposure> =>
    agentSelfRequest<A2aSelfExposure>(
        global,
        apiPaths.AGENT_SELF_A2A_EXPOSURE,
        'PUT',
        'a2a:edit',
        { enabled }
    )

export const fetchSelfCallers = (
    global: GlobalAuthOpts
): Promise<A2aGrantSummary[]> =>
    agentSelfRequest<A2aGrantSummary[]>(
        global,
        apiPaths.AGENT_SELF_A2A_CALLERS,
        'GET'
    )

export const addSelfCaller = (
    global: GlobalAuthOpts,
    body: AddA2aSelfCallerBody
): Promise<A2aSelfCallerAddResponse> =>
    agentSelfRequest<A2aSelfCallerAddResponse>(
        global,
        apiPaths.AGENT_SELF_A2A_CALLERS,
        'POST',
        'a2a:edit',
        body
    )

export const revokeSelfCaller = (
    global: GlobalAuthOpts,
    tokenId: string
): Promise<void> =>
    agentSelfRequest<void>(
        global,
        apiPaths.AGENT_SELF_A2A_CALLER_BY_ID(tokenId),
        'DELETE',
        'a2a:edit'
    )

export interface ResolvedPeerCall {
    name: string
    rpcUrl: string
    token: string
    expiresAt: string
}

// List peers, match the requested one, and mint a per-call bearer — the full
// resolution `mf a2a call` needs. Returns an `error` string for any failure so
// the command can print it and exit without try/catch threading.
export const resolvePeerForCall = async (
    global: GlobalAuthOpts,
    ref: string
): Promise<ResolvedPeerCall | { error: string }> => {
    try {
        const match = findSelfPeer(await fetchSelfPeers(global), ref)
        if (!match)
            return {
                error: `no granted peer matching "${ref}" — run \`mf a2a peers\` to list`
            }
        const minted = await mintSelfPeerToken(global, match.agentId)
        return {
            name: match.name,
            rpcUrl: minted.rpcUrl,
            token: minted.token,
            expiresAt: minted.expiresAt
        }
    } catch (err) {
        return { error: (err as Error).message }
    }
}
