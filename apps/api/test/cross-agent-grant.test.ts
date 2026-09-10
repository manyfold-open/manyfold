import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ACCOUNT_SCOPE_HEADER } from '@manyfold/shared'
import { AuthGuard } from '../src/common/guards/auth.guard'
import { AuthzService } from '../src/modules/auth/authz.service'
import type { AuthPrincipal } from '../src/modules/auth/auth-principal'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import {
    SUBJECT_AGENT_META,
    type SubjectAgentClassification
} from '../src/common/decorators/subject-agent.decorator'
import { boundAgentIdFromUser } from '../src/modules/agents/agents.controller'

const makeGuard = (principal: AuthPrincipal): AuthGuard => {
    const reflector = new Reflector()
    const resolver = { resolveAgentId: async () => 'agt_B' } as never
    const authz = new AuthzService(
        reflector,
        {} as never,
        resolver,
        resolver,
        resolver,
        resolver,
        resolver,
        resolver
    )
    return new AuthGuard(
        { verifyBearerToken: async () => principal } as never,
        reflector,
        authz
    )
}

const context = (
    subject: SubjectAgentClassification | null,
    target: string,
    account = false
): ExecutionContext => {
    const handler = () => {}
    Reflect.defineMetadata(
        REQUIRED_API_TOKEN_SCOPES_META,
        ['a2a:edit'],
        handler
    )
    if (subject) Reflect.defineMetadata(SUBJECT_AGENT_META, subject, handler)
    return {
        switchToHttp: () => ({
            getRequest: () => ({
                headers: {
                    authorization: 'Bearer nca_test',
                    ...(account ? { [ACCOUNT_SCOPE_HEADER]: '1' } : {})
                },
                params: { id: target },
                body: { agentId: target },
                query: { agentId: target }
            })
        }),
        getHandler: () => handler,
        getClass: () => class {}
    } as unknown as ExecutionContext
}

for (const callerAgentId of [null, 'agt_caller']) {
    const principal: AuthPrincipal = {
        userId: 'user-1',
        kind: 'legacy-runtime',
        tokenKind: 'a2a-grant',
        agentId: 'agt_A',
        tokenId: 'pat_a2a',
        callerAgentId,
        scopes: ['a2a:edit'],
        createdVia: 'api'
    }

    test(`A2A ${callerAgentId ?? 'external'} grant stays bound across request shapes`, async () => {
        const guard = makeGuard(principal)
        for (const subject of [
            { type: 'path', param: 'id' },
            { type: 'body', field: 'agentId' },
            { type: 'query', field: 'agentId' }
        ] as const) {
            assert.equal(
                await guard.canActivate(context(subject, 'agt_A')),
                true
            )
            await assert.rejects(
                guard.canActivate(context(subject, 'agt_B')),
                ForbiddenException
            )
        }
        await assert.rejects(
            guard.canActivate(
                context({ type: 'path', param: 'id' }, 'agt_B', true)
            ),
            ForbiddenException
        )
    })

    test(`A2A ${callerAgentId ?? 'external'} grant fails closed and retains list filtering`, async () => {
        const guard = makeGuard(principal)
        await assert.rejects(
            guard.canActivate(context(null, 'agt_A')),
            ForbiddenException
        )
        await assert.rejects(
            guard.canActivate(context({ type: 'deny-bound' }, 'agt_A')),
            ForbiddenException
        )
        assert.equal(
            await guard.canActivate(
                context({ type: 'list-filtered' }, 'agt_A')
            ),
            true
        )
        assert.equal(boundAgentIdFromUser(principal), 'agt_A')
    })
}
