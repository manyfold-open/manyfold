import type { FastifyRequest } from 'fastify'
import { A2aError, A2aErrorCode, type JsonRpcErrorBody } from '@manyfold/a2a'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import {
    API_TOKEN_SCOPE_A2A,
    ApiTokenService,
    apiTokenHasScope,
    isApiToken
} from '@/modules/auth/api-token.service'
import type { A2aAuthContext } from './a2a.service'
import { A2aTicketError, A2aTicketService } from './a2a-ticket.service'

// Auth/transport failures map to HTTP status (A2A §4), NOT a JSON-RPC error
// body — only method/param/task errors go in the JSON-RPC envelope.
export class A2aHttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
        this.name = 'A2aHttpError'
    }
}

export const authenticateA2aRequest = async (
    auth: BearerAuthService,
    req: FastifyRequest,
    targetAgentId: string,
    tickets: A2aTicketService,
    tokens: ApiTokenService
): Promise<A2aAuthContext> => {
    const header = req.headers.authorization
    const token =
        typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice(7).trim()
            : null
    if (!token) throw new A2aHttpError(401, 'missing bearer token')

    // Stateless ticket (§6.3): the per-call peer bearer carries an encrypted
    // {callerAgentId, targetAgentId, userId, exp}. Bind the caller from the
    // payload; the controller still re-checks isActiveA2aGrant pre-dispatch
    // (ticket = freshness, grant = authority).
    if (tickets.isA2aTicket(token)) {
        let payload
        try {
            payload = tickets.verify(token)
        } catch (err) {
            if (err instanceof A2aTicketError)
                throw new A2aHttpError(401, 'invalid or expired a2a ticket')
            throw err
        }
        if (payload.targetAgentId !== targetAgentId)
            throw new A2aHttpError(403, 'a2a ticket target mismatch')
        return {
            userId: payload.userId,
            targetAgentId,
            callerAgentId: payload.callerAgentId,
            externalSubject: null,
            tokenId: null
        }
    }

    // Legacy DB-token path: internal a2a-grant bearers + draining a2a-ephemeral
    // rows authenticate here until the 15-min TTL drains them (no dual-accept).
    if (!isApiToken(token)) throw new A2aHttpError(401, 'invalid api token')
    let user
    try {
        user = await auth.verifyBearerToken(token)
    } catch (err) {
        throw new A2aHttpError(401, (err as Error).message)
    }
    if (!apiTokenHasScope(user, API_TOKEN_SCOPE_A2A))
        throw new A2aHttpError(403, 'token missing a2a:edit scope')

    // Internal caller: an a2a-grant bearer that names the calling agent. The
    // controller re-checks the grant per call (real-time revoke).
    if (user.kind === 'legacy-runtime' && user.callerAgentId) {
        if (user.agentId !== targetAgentId)
            throw new A2aHttpError(403, 'token not authorized for this agent')
        return {
            userId: user.userId,
            targetAgentId,
            callerAgentId: user.callerAgentId,
            externalSubject: null,
            tokenId: user.tokenId
        }
    }

    // External caller (third-party client / SDK): authority is the caller-less
    // `a2a-grant` row bound to THIS target, which is the durable per-token
    // target allowlist Phase 7a said was missing. Re-read per call so revoke
    // and expiry bite immediately. Anything else holding an a2a:edit scope —
    // an unbound PAT above all — matches no such row and stops here.
    const tokenId =
        user.kind === 'human-api-token' || user.kind === 'legacy-runtime'
            ? user.tokenId
            : null
    if (
        !tokenId ||
        !(await tokens.isActiveExternalA2aGrant(tokenId, targetAgentId))
    )
        throw new A2aHttpError(
            403,
            'token is not an external A2A client token for this agent'
        )
    return {
        userId: user.userId,
        targetAgentId,
        callerAgentId: null,
        externalSubject: tokenId,
        tokenId
    }
}

export const toJsonRpcError = (err: unknown): JsonRpcErrorBody => {
    if (err instanceof A2aError) return err.toJsonRpc()
    return {
        code: A2aErrorCode.internalError,
        message: err instanceof Error ? err.message : 'internal error'
    }
}
