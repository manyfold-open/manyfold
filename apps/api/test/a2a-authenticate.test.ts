import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ConfigService } from '@nestjs/config'
import type { BearerAuthService } from '../src/modules/auth/bearer-auth.service'
import {
    A2aHttpError,
    authenticateA2aRequest
} from '../src/modules/a2a/a2a-http'
import { A2aTicketService } from '../src/modules/a2a/a2a-ticket.service'
import { A2aRpcController } from '../src/modules/a2a/a2a-rpc.controller'
import type { A2aService } from '../src/modules/a2a/a2a.service'
import type { ApiTokenService } from '../src/modules/auth/api-token.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'

const TEST_KEY = Buffer.alloc(32, 7).toString('base64')

const ticketSvc = (): A2aTicketService =>
    new A2aTicketService(
        new CryptoService(new ConfigService({ API_CRYPTO_KEY: TEST_KEY }))
    )

const reqWith = (token: string): FastifyRequest =>
    ({ headers: { authorization: `Bearer ${token}` } }) as FastifyRequest

// A bearer service that fails the test if it is ever consulted — proves the
// ticket branch resolves WITHOUT a DB lookup.
const noVerify = (): BearerAuthService =>
    ({
        verifyBearerToken: async () => {
            throw new Error('verifyBearerToken must not be called for a ticket')
        }
    }) as unknown as BearerAuthService

// A token service whose external-allowlist answer the test controls. Calls are
// recorded so a test can prove the lookup was keyed by (tokenId, target).
const tokensAllowing = (
    allow: boolean,
    seen: Array<{ tokenId: string; targetAgentId: string }> = []
): ApiTokenService =>
    ({
        isActiveExternalA2aGrant: async (
            tokenId: string,
            targetAgentId: string
        ) => {
            seen.push({ tokenId, targetAgentId })
            return allow
        }
    }) as unknown as ApiTokenService

// ---- ticket branch ----

test('ticket branch returns ctx with callerAgentId from the payload', async () => {
    const tickets = ticketSvc()
    const { ticket } = tickets.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    const ctx = await authenticateA2aRequest(
        noVerify(),
        reqWith(ticket),
        'agt_target',
        tickets,
        tokensAllowing(false)
    )
    assert.equal(ctx.userId, 'user-1')
    assert.equal(ctx.callerAgentId, 'agt_caller')
    assert.equal(ctx.targetAgentId, 'agt_target')
    assert.equal(ctx.externalSubject, null)
    assert.equal(ctx.tokenId, null)
})

test('ticket with a mismatched target → A2aHttpError(403)', async () => {
    const tickets = ticketSvc()
    const { ticket } = tickets.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                noVerify(),
                reqWith(ticket),
                'agt_other',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 403 &&
            /target mismatch/.test(err.message)
    )
})

test('corrupt ticket → A2aHttpError(401)', async () => {
    const tickets = ticketSvc()
    const { ticket } = tickets.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    const tampered = ticket.slice(0, -4) + 'AAAA'
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                noVerify(),
                reqWith(tampered),
                'agt_target',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 401 &&
            /invalid or expired a2a ticket/.test(err.message)
    )
})

test('expired ticket → A2aHttpError(401)', async () => {
    const config = new ConfigService({ API_CRYPTO_KEY: TEST_KEY })
    const crypto = new CryptoService(config)
    const tickets = new A2aTicketService(crypto)
    const enc = crypto.encrypt(
        JSON.stringify({
            callerAgentId: 'agt_caller',
            targetAgentId: 'agt_target',
            userId: 'user-1',
            exp: 1
        })
    )
    const expired =
        'mfa2a_' + Buffer.from(JSON.stringify(enc)).toString('base64url')
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                noVerify(),
                reqWith(expired),
                'agt_target',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 401 &&
            /invalid or expired a2a ticket/.test(err.message)
    )
})

// ---- legacy DB-token path ----

const authReturning = (principal: Record<string, unknown>): BearerAuthService =>
    ({
        verifyBearerToken: async () => principal
    }) as unknown as BearerAuthService

test('legacy a2a-grant token (callerAgentId set) still authenticates', async () => {
    const tickets = ticketSvc()
    const auth = authReturning({
        userId: 'user-1',
        kind: 'legacy-runtime',
        agentId: 'agt_target',
        tokenId: 'pat_1',
        scopes: ['a2a:edit'],
        callerAgentId: 'agt_caller',
        enforceAgentBinding: true,
        createdVia: 'api'
    })
    const ctx = await authenticateA2aRequest(
        auth,
        reqWith('nca_legacy'),
        'agt_target',
        tickets,
        tokensAllowing(false)
    )
    assert.equal(ctx.callerAgentId, 'agt_caller')
    assert.equal(ctx.targetAgentId, 'agt_target')
    assert.equal(ctx.tokenId, 'pat_1')
    assert.equal(ctx.externalSubject, null)
})

test('external client token bound to this target authenticates as an external subject', async () => {
    // The identity fields asserted here are what scope task visibility
    // (a2a_tasks.external_subject): externalSubject MUST be the tokenId and
    // callerAgentId MUST stay null, or one external client could read another's
    // tasks — or be mistaken for an internal peer by the grant re-check.
    const tickets = ticketSvc()
    const seen: Array<{ tokenId: string; targetAgentId: string }> = []
    const auth = authReturning({
        userId: 'user-1',
        kind: 'legacy-runtime',
        agentId: 'agt_target',
        tokenId: 'pat_ext',
        scopes: ['a2a:edit'],
        callerAgentId: null,
        enforceAgentBinding: true,
        createdVia: 'api'
    })
    const ctx = await authenticateA2aRequest(
        auth,
        reqWith('nca_external'),
        'agt_target',
        tickets,
        tokensAllowing(true, seen)
    )
    assert.equal(ctx.userId, 'user-1')
    assert.equal(ctx.targetAgentId, 'agt_target')
    assert.equal(ctx.callerAgentId, null)
    assert.equal(ctx.externalSubject, 'pat_ext')
    assert.equal(ctx.tokenId, 'pat_ext')
    // The allowlist is per (token, target) — not per token.
    assert.deepEqual(seen, [
        { tokenId: 'pat_ext', targetAgentId: 'agt_target' }
    ])
})

test('a2a:edit token with no external grant for this target → A2aHttpError(403)', async () => {
    // Covers every allowlist miss the query fails closed on: an unbound PAT
    // scoped a2a:edit, a token minted for a DIFFERENT agent, and a revoked or
    // expired external grant. None of them may reach an exposed agent.
    const tickets = ticketSvc()
    const auth = authReturning({
        userId: 'user-1',
        kind: 'human-api-token',
        tokenId: 'pat_unbound',
        scopes: ['a2a:edit']
    })
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                auth,
                reqWith('nca_external'),
                'agt_target',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 403 &&
            /not an external A2A client token for this agent/.test(err.message)
    )
})

test('legacy token missing a2a:edit scope → A2aHttpError(403)', async () => {
    const tickets = ticketSvc()
    const auth = authReturning({
        userId: 'user-1',
        kind: 'legacy-runtime',
        agentId: 'agt_target',
        tokenId: 'pat_1',
        scopes: ['channels:read'],
        callerAgentId: 'agt_caller',
        enforceAgentBinding: true,
        createdVia: 'api'
    })
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                auth,
                reqWith('nca_legacy'),
                'agt_target',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 403 &&
            /a2a:edit/.test(err.message)
    )
})

test('non-nca, non-ticket token → A2aHttpError(401)', async () => {
    const tickets = ticketSvc()
    await assert.rejects(
        () =>
            authenticateA2aRequest(
                noVerify(),
                reqWith('bogus_token'),
                'agt_target',
                tickets,
                tokensAllowing(false)
            ),
        (err: unknown) =>
            err instanceof A2aHttpError &&
            err.status === 401 &&
            /invalid api token/.test(err.message)
    )
})

// ---- controller grant re-check (ticket caller with NO active grant → 403) ----

interface CapturedReply {
    status: number | null
    body: unknown
    reply: FastifyReply
}

const captureReply = (): CapturedReply => {
    const captured: CapturedReply = {
        status: null,
        body: undefined,
        reply: undefined as unknown as FastifyReply
    }
    const reply = {
        status(code: number) {
            captured.status = code
            return this
        },
        send(payload: unknown) {
            captured.body = payload
            return this
        }
    } as unknown as FastifyReply
    captured.reply = reply
    return captured
}

const buildController = (
    isActiveA2aGrant: boolean,
    opts: {
        bearer?: BearerAuthService
        isActiveExternalA2aGrant?: boolean
        sendMessage?: () => Promise<unknown>
    } = {}
): A2aRpcController => {
    const a2a = {
        getExposure: async () => ({ enabled: true }),
        sendMessage: opts.sendMessage ?? (async () => ({ kind: 'task' }))
    } as unknown as A2aService
    const apiQuota = { assertAndIncrement: async () => {} }
    const rateLimit = { consume: () => {} }
    const tokens = {
        isActiveA2aGrant: async () => isActiveA2aGrant,
        isActiveExternalA2aGrant: async () =>
            opts.isActiveExternalA2aGrant ?? false
    } as unknown as ApiTokenService
    return new A2aRpcController(
        a2a,
        opts.bearer ?? noVerify(),
        apiQuota as never,
        rateLimit as never,
        tokens,
        ticketSvc()
    )
}

test('controller re-checks isActiveA2aGrant: ticket caller WITHOUT a grant → 403', async () => {
    // A valid, unexpired ticket whose caller has no live grant must still be
    // rejected pre-dispatch — the ticket proves freshness, the grant is the
    // authority (M-sec-5). The ticket the test forges targets agt_target so it
    // passes authentication, then trips the grant re-check.
    const controller = buildController(false)
    const tickets = ticketSvc()
    const { ticket } = tickets.sign({
        callerAgentId: 'agt_caller',
        targetAgentId: 'agt_target',
        userId: 'user-1'
    })
    const captured = captureReply()
    await controller.rpc(
        'agt_target',
        { jsonrpc: '2.0', method: 'message/send', params: {}, id: 1 },
        reqWith(ticket),
        captured.reply
    )
    assert.equal(captured.status, 403)
    assert.deepEqual(captured.body, {
        error: 'a2a grant revoked or expired'
    })
})

test('controller dispatches an external client call even though it holds no peer grant', async () => {
    // The isActiveA2aGrant re-check is the INTERNAL caller's authority. An
    // external client has no caller agent and no peer grant, so a false answer
    // there must not touch it — its authority was already proven by the
    // per-token allowlist during authentication. Without this the external path
    // would 403 on every call.
    let dispatched = false
    const controller = buildController(false, {
        bearer: authReturning({
            userId: 'user-1',
            kind: 'legacy-runtime',
            agentId: 'agt_target',
            tokenId: 'pat_ext',
            scopes: ['a2a:edit'],
            callerAgentId: null,
            enforceAgentBinding: true,
            createdVia: 'api'
        }),
        isActiveExternalA2aGrant: true,
        sendMessage: async () => {
            dispatched = true
            return { kind: 'task', id: 'aat_1' }
        }
    })
    const captured = captureReply()
    await controller.rpc(
        'agt_target',
        { jsonrpc: '2.0', method: 'message/send', params: {}, id: 7 },
        reqWith('nca_external'),
        captured.reply
    )
    assert.equal(dispatched, true)
    assert.equal(captured.status, 200)
    assert.deepEqual(captured.body, {
        jsonrpc: '2.0',
        id: 7,
        result: { kind: 'task', id: 'aat_1' }
    })
})
