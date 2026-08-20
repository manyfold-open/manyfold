import type { FastifyRequest } from 'fastify'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import type { AuthPrincipal } from '@/modules/auth/auth-principal'
import {
    API_TOKEN_SCOPE_CHAT_COMPLETIONS,
    apiTokenHasScope,
    isApiToken,
    isRuntimeToken
} from '@/modules/auth/api-token.service'
import { principalAgentId } from '@/modules/auth/auth-principal'
import { OpenAiCompatError } from './openai-chat-completions.service'

// Shared bearer-token auth for the OpenAI-compatible /v1 surface. These
// endpoints are deliberately guard-free: they catch and re-shape every error
// into the OpenAI {error:{message,type,code}} body, which AuthGuard + the
// global HttpExceptionFilter (brand-shaped apiError) would not produce. A
// chat.completions scope is sufficient (api.full passes) — the same token a
// caller already uses for completions reads its own history.
export const authenticateOpenAiRequest = async (
    auth: BearerAuthService,
    req: FastifyRequest
): Promise<AuthPrincipal> => {
    const header = req.headers.authorization
    const token =
        typeof header === 'string' && header.startsWith('Bearer ')
            ? header.slice(7).trim()
            : null
    if (!token)
        throw new OpenAiCompatError(
            401,
            'Missing bearer token',
            'authentication_error',
            'missing_api_key'
        )
    if (!isApiToken(token))
        throw new OpenAiCompatError(
            401,
            'OpenAI-compatible API requires an nca_ API token',
            'authentication_error',
            'invalid_api_key'
        )
    // Reject runtime identity tokens by prefix before any DB lookup (§5.6); the
    // kind check after verify() is the backstop for any that slip the prefix.
    if (isRuntimeToken(token))
        throw new OpenAiCompatError(
            401,
            'agent runtime identity tokens cannot access the OpenAI-compatible API',
            'authentication_error',
            'invalid_api_key'
        )
    try {
        const user = await auth.verifyBearerToken(token)
        // Any agent-bound token (agent-runtime or legacy-runtime) is rejected —
        // the account-level /v1 surface is for human/account tokens only. The
        // kind backstop also catches a runtime bearer that slipped the prefix
        // early-reject above.
        if (principalAgentId(user))
            throw new OpenAiCompatError(
                401,
                'agent runtime identity tokens cannot access the OpenAI-compatible API',
                'authentication_error',
                'invalid_api_key'
            )
        if (!apiTokenHasScope(user, API_TOKEN_SCOPE_CHAT_COMPLETIONS))
            throw new OpenAiCompatError(
                401,
                'API token does not have chat.completions scope',
                'authentication_error',
                'invalid_api_key'
            )
        return user
    } catch (err) {
        if (err instanceof OpenAiCompatError) throw err
        throw new OpenAiCompatError(
            401,
            (err as Error).message,
            'authentication_error',
            'invalid_api_key'
        )
    }
}