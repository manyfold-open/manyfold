import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    apiTokens,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'

// Real-Postgres proof for the external-A2A-client allowlist. The inbound /rpc
// path accepts a third-party bearer ONLY when isActiveExternalA2aGrant finds a
// caller-less `a2a-grant` row bound to the very agent being called — that row is
// the per-token target allowlist. Every condition in it is load-bearing, and a
// fake DB cannot prove any of them (the in-memory harness in
// api-token.service.grant.test.ts sniffs where-params and models neither
// token_kind nor caller_agent_id IS NULL, so a regression there would still pass).
// Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test --test-force-exit test/external-a2a-grant.pg.test.ts
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    tokens: ApiTokenService
    userId: string
    targetId: string
    otherTargetId: string
    callerId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const targetId = `agt_pgtest_t_${suffix}`
    const otherTargetId = `agt_pgtest_o_${suffix}`
    const callerId = `agt_pgtest_c_${suffix}`

    await db.insert(users).values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })
    for (const id of [targetId, otherTargetId, callerId])
        await db.insert(agents).values({
            id,
            userId,
            name: `pgtest-${id}`,
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${id}`
        })

    return {
        db,
        tokens: new ApiTokenService(db),
        userId,
        targetId,
        otherTargetId,
        callerId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

test('external A2A grant allowlist admits only the caller-less grant for that agent', {
    skip: RUN ? false : 'set RUN_PG_E2E=1 with a migrated DATABASE_URL'
}, async (t) => {
    const h = await buildHarness()
    t.after(() => h.close())

    // What the A2A tab's "External client" button mints.
    const external = await h.tokens.mintA2aGrant({
        userId: h.userId,
        targetAgentId: h.targetId,
        name: 'pgtest-external-client'
    })

    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(external.tokenId, h.targetId),
        true,
        'the external grant must admit its own target'
    )

    // Single-target: the same bearer may not reach a second exposed agent.
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(
            external.tokenId,
            h.otherTargetId
        ),
        false,
        'an external grant must not admit any other agent'
    )

    // A caller-bound peer grant is the INTERNAL credential; it must not pass as
    // an external client (its authority is re-checked as a peer grant instead).
    const peer = await h.tokens.mintA2aGrant({
        userId: h.userId,
        targetAgentId: h.targetId,
        callerAgentId: h.callerId
    })
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(peer.tokenId, h.targetId),
        false,
        'a caller-bound grant is not an external client token'
    )
    await assert.rejects(
        () =>
            h.tokens.mintA2aGrants({
                userId: h.userId,
                targetAgentId: h.targetId,
                callerAgentIds: [h.callerId]
            }),
        /already has an active A2A grant/
    )
    const [replacementPeer] = await h.tokens.mintA2aGrants({
        userId: h.userId,
        targetAgentId: h.targetId,
        callerAgentIds: [h.callerId],
        replaceExisting: true
    })
    assert.ok(replacementPeer, 'replace must return the new peer grant metadata')
    await h.tokens.revokeA2aGrant({
        tokenId: peer.tokenId,
        userId: h.userId,
        targetAgentId: h.targetId
    })
    assert.equal(
        await h.tokens.isActiveA2aGrant(h.callerId, h.targetId),
        true,
        'revoking a stale replaced token must not revoke the current typed grant'
    )

    // A plain personal token scoped a2a:edit has no agent binding at all. This
    // is the fail-closed case that keeps "any PAT can call any exposed agent"
    // from ever being true.
    const pat = await h.tokens.mint({
        userId: h.userId,
        name: 'pgtest-pat',
        scopes: ['a2a:edit']
    })
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(pat.tokenId, h.targetId),
        false,
        'an unbound personal token is never an external client token'
    )

    await h.tokens.revokeA2aGrant({
        tokenId: external.tokenId,
        userId: h.userId,
        targetAgentId: h.otherTargetId
    })
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(external.tokenId, h.targetId),
        true,
        'a caller revoke must be scoped to the target agent in the route'
    )

    // Revoke from the callers list must bite on the very next call.
    await h.tokens.revokeA2aGrant({
        tokenId: external.tokenId,
        userId: h.userId,
        targetAgentId: h.targetId
    })
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(external.tokenId, h.targetId),
        false,
        'a revoked external grant must stop admitting calls'
    )

    assert.equal(
        await h.tokens.isActiveA2aGrant(h.callerId, h.targetId),
        true,
        'the peer grant starts active in the dual-read model'
    )
    await h.tokens.revokeA2aGrant({
        tokenId: replacementPeer.tokenId,
        userId: h.userId,
        targetAgentId: h.targetId
    })
    assert.equal(
        await h.tokens.isActiveA2aGrant(h.callerId, h.targetId),
        false,
        'peer revoke must update both api_tokens and a2a_agent_grants'
    )

    // Expiry is enforced by the query, not by a sweep job.
    const expiring = await h.tokens.mintA2aGrant({
        userId: h.userId,
        targetAgentId: h.targetId,
        name: 'pgtest-expiring'
    })
    await h.db
        .update(apiTokens)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(apiTokens.id, expiring.tokenId))
    assert.equal(
        await h.tokens.isActiveExternalA2aGrant(expiring.tokenId, h.targetId),
        false,
        'an expired external grant must stop admitting calls'
    )
})
