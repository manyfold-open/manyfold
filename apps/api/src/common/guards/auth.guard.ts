import {
    ACCOUNT_SCOPE_HEADER,
    ApiTokenScope
} from '@manyfold/shared'
import {
    Injectable,
    InternalServerErrorException,
    Logger,
    UnauthorizedException,
    type CanActivate,
    type ExecutionContext
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { FastifyRequest } from 'fastify'
import { BearerAuthService } from '@/modules/auth/bearer-auth.service'
import {
    principalScopes,
    type AuthPrincipal
} from '@/modules/auth/auth-principal'
import {
    API_TOKEN_SCOPE_FULL,
    apiTokenHasScope
} from '@/modules/auth/api-token.service'
import {
    AuthzService,
    type SubjectResolution
} from '@/modules/auth/authz.service'
import { REQUIRED_API_TOKEN_SCOPES_META } from '@/common/decorators/require-api-token-scope.decorator'
import { REQUIRE_AUTH_SESSION_META } from '@/common/decorators/require-auth-session.decorator'
import { ALLOW_RUNTIME_SELF_META } from '@/common/decorators/allow-runtime-self.decorator'

export type { AuthPrincipal }

@Injectable()
export class AuthGuard implements CanActivate {
    private readonly log = new Logger(AuthGuard.name)

    constructor(
        private readonly bearerAuth: BearerAuthService,
        private readonly reflector: Reflector,
        private readonly authz: AuthzService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context
            .switchToHttp()
            .getRequest<FastifyRequest & { auth?: AuthPrincipal }>()
        const header = req.headers['authorization']
        const token =
            typeof header === 'string' && header.startsWith('Bearer ')
                ? header.slice(7)
                : null
        if (!token) throw new UnauthorizedException('Missing bearer token')

        try {
            req.auth = await this.bearerAuth.verifyBearerToken(token)
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error
            if (isAuthStoreMigrationError(error)) {
                this.log.error(
                    `authentication store is not migrated: ${(error as Error).message}`
                )
                throw new InternalServerErrorException(
                    'Authentication store is not migrated'
                )
            }
            throw new UnauthorizedException((error as Error).message)
        }

        const requireAuthSession =
            this.reflector.getAllAndOverride<boolean>(
                REQUIRE_AUTH_SESSION_META,
                [context.getHandler(), context.getClass()]
            ) === true

        if (req.auth.kind === 'human-session') return true

        if (requireAuthSession) {
            throw new UnauthorizedException(
                'this endpoint requires an auth session; API tokens are not accepted'
            )
        }

        // Agent-runtime identity: authorization comes from agent_permissions,
        // never from token scopes and never via api.full. Resolved per request
        // (no cache). Boundary/audit reuse the existing path below.
        if (req.auth.kind === 'agent-runtime') {
            const agentId = req.auth.agentId
            const allowRuntimeSelf =
                this.reflector.getAllAndOverride<boolean>(
                    ALLOW_RUNTIME_SELF_META,
                    [context.getHandler(), context.getClass()]
                ) === true
            const resolution = await this.authz.resolveSubjectAgent(context, req)
            // Self-service endpoints (e.g. requesting a missing permission) are
            // callable by the identity WITHOUT any agent_permissions scope —
            // otherwise an agent could never ask for the scope it lacks. Still
            // hard-bound: the subject must be this token's own agent.
            if (allowRuntimeSelf) {
                this.authz.assertBoundTokenSubject(agentId, resolution)
                return true
            }
            // `--account` intent (ADR-0010): the client asks to act at account
            // scope. Intent only — authorization below is still the endpoint's
            // scope from agent_permissions plus an intra-user ownership check.
            const accountScope = isAccountScopeIntent(req)
            // Agent scope (ADR-0010): without account intent, a runtime identity
            // operates its OWN resources with no agent_permissions scope. "Own" =
            // the subject-agent classification resolves to this agent, or a
            // bound-filtered list. Account-level / cross-agent targets fall
            // through to the scope check below.
            if (!accountScope && isAgentScopedSelf(resolution, agentId)) {
                this.authz.assertBoundTokenSubject(agentId, resolution)
                return true
            }
            const required = this.reflector.getAllAndOverride<ApiTokenScope[]>(
                REQUIRED_API_TOKEN_SCOPES_META,
                [context.getHandler(), context.getClass()]
            )
            if (!required || required.length === 0) {
                throw new UnauthorizedException(
                    'this endpoint requires an api.full token; agent runtime tokens cannot access it'
                )
            }
            const granted = await this.authz.getAgentPermissionScopes(agentId)
            const matched = required.filter((s) => granted.includes(s))
            if (matched.length === 0) {
                throw new UnauthorizedException(
                    `agent permission missing scope: one of [${required.join(', ')}]`
                )
            }
            req.auth.matchedScopes = matched
            if (accountScope) {
                // Account scope: the grant authorizes reach BEYOND this agent,
                // bounded to the same user account — replace the self-bind with
                // an intra-user ownership assertion (ADR-0010). Reveal / billing
                // carve-outs are enforced at their own handlers, not here.
                req.auth.accountScope = true
                await this.authz.assertAccountSubject(
                    resolution,
                    req.auth.userId
                )
                return true
            }
            // No account intent: cross-agent reach stays hard-bound to this
            // agent — assert the subject is this agent; 403 on mismatch.
            this.authz.assertBoundTokenSubject(agentId, resolution)
            return true
        }

        if (apiTokenHasScope(req.auth, API_TOKEN_SCOPE_FULL)) {
            req.auth.matchedScopes = [API_TOKEN_SCOPE_FULL]
            await this.enforceAgentBinding(context, req)
            return true
        }

        const required = this.reflector.getAllAndOverride<ApiTokenScope[]>(
            REQUIRED_API_TOKEN_SCOPES_META,
            [context.getHandler(), context.getClass()]
        )

        if (!required || required.length === 0) {
            throw new UnauthorizedException(
                'this endpoint requires api.full token; narrow scope tokens cannot access it'
            )
        }

        const tokenScopes = principalScopes(req.auth)
        const matched = required.filter((s) => tokenScopes.includes(s))
        if (matched.length === 0) {
            throw new UnauthorizedException(
                `token missing scope: one of [${required.join(', ')}]`
            )
        }
        req.auth.matchedScopes = matched
        await this.enforceAgentBinding(context, req)
        return true
    }

    private async enforceAgentBinding(
        context: ExecutionContext,
        req: FastifyRequest & { auth?: AuthPrincipal }
    ): Promise<void> {
        // Only legacy-runtime tokens carry an agent binding to enforce/audit.
        // human-api-token (no agentId) is a personal PAT — nothing to audit.
        const token = req.auth?.kind === 'legacy-runtime' ? req.auth : null
        if (!token) return
        if (token.enforceAgentBinding) {
            const resolution = await this.authz.resolveSubjectAgent(
                context,
                req
            )
            this.authz.assertBoundTokenSubject(token.agentId, resolution)
            return
        }
        // Unbound grant token (v1 + v15 cli-poll back-compat). Detect
        // cross-agent use for v2 observability dashboard. Never block —
        // just audit (fire-and-forget on a best-effort basis).
        const resolution = await this.authz.resolveSubjectAgent(context, req)
        const subject = resolution.subjectAgentId
        if (!subject || subject === token.agentId) return
        void this.authz
            .recordCrossAgentUse({
                tokenId: token.tokenId,
                userId: token.userId,
                fromAgent: token.agentId,
                toAgent: subject,
                scopes: req.auth?.matchedScopes ?? token.scopes,
                endpoint: `${req.method ?? ''} ${req.url ?? ''}`.trim()
            })
            .catch(() => {
                /* already logged inside recordCrossAgentUse */
            })
    }
}

// Agent scope (ADR-0010): a runtime identity reaches its OWN resources for
// free. "Own" is read off the endpoint's subject-agent classification: a
// bound-filtered list is narrowed to this agent by the service layer; a
// subject-carrying endpoint is self only when the resolved subject IS this
// agent. Account-level classifications (deny-bound / user-level allowlisted)
// and a null (undecorated) classification are never agent-scoped self — they
// stay scope-gated.
const isAgentScopedSelf = (
    resolution: SubjectResolution,
    agentId: string
): boolean => {
    const cls = resolution.classification
    if (!cls) return false
    if (cls.type === 'list-filtered') return true
    if (
        cls.type === 'path' ||
        cls.type === 'body' ||
        cls.type === 'query' ||
        cls.type === 'resource'
    )
        return resolution.subjectAgentId === agentId
    return false
}

const isAccountScopeIntent = (req: FastifyRequest): boolean => {
    const value = req.headers[ACCOUNT_SCOPE_HEADER]
    return value === '1' || value === 'true'
}

const isAuthStoreMigrationError = (error: unknown): boolean => {
    const code = (error as { code?: unknown })?.code
    if (code === '42P01') return true
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('relation "auth_identities" does not exist')
}
