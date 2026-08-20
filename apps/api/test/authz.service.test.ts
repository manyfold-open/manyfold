import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
    SUBJECT_AGENT_META,
    type SubjectAgentClassification
} from '../src/common/decorators/subject-agent.decorator'
import { AuthzService } from '../src/modules/auth/authz.service'

interface FakeRequest {
    params?: Record<string, unknown>
    body?: Record<string, unknown>
    query?: Record<string, unknown>
    auth?: { userId: string }
    resourceAgentCache?: Map<string, string | null>
}

const ctxFor = (
    handler: () => unknown = () => {},
    klass: { new (): unknown } = class {}
): ExecutionContext =>
    ({
        getHandler: () => handler,
        getClass: () => klass
    }) as unknown as ExecutionContext

const declare = (
    classification: SubjectAgentClassification
): (() => unknown) => {
    const fn = () => {}
    Reflect.defineMetadata(SUBJECT_AGENT_META, classification, fn)
    return fn
}

interface CountingResolver {
    resolveAgentId: (resourceId: string, userId: string) => Promise<string | null>
    callCount: number
}

const makeResolver = (
    map: Record<string, string | null>
): CountingResolver => {
    const resolver: CountingResolver = {
        callCount: 0,
        resolveAgentId: async (resourceId: string) => {
            resolver.callCount += 1
            return resourceId in map ? map[resourceId] : null
        }
    }
    return resolver
}

const buildAuthz = (
    overrides: Partial<{
        channel: CountingResolver
        automation: CountingResolver
        userSkill: CountingResolver
        backup: CountingResolver
        backupRestore: CountingResolver
        agentRuntime: CountingResolver
    }> = {}
): AuthzService => {
    const empty = makeResolver({})
    const fakeDb = {
        insert: () => ({
            values: () => Promise.resolve([])
        })
    }
    return new AuthzService(
        new Reflector(),
        fakeDb as never,
        (overrides.channel ?? empty) as never,
        (overrides.automation ?? empty) as never,
        (overrides.userSkill ?? empty) as never,
        (overrides.backup ?? empty) as never,
        (overrides.backupRestore ?? empty) as never,
        (overrides.agentRuntime ?? empty) as never
    )
}

test('classify returns null when handler has no SUBJECT_AGENT_META', () => {
    const authz = buildAuthz()
    assert.equal(authz.classify(ctxFor()), null)
})

test('classify returns the classification from method metadata', () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'path', param: 'id' })
    assert.deepEqual(authz.classify(ctxFor(handler)), {
        type: 'path',
        param: 'id'
    })
})

test('resolveSubjectAgent path reads req.params[param]', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'path', param: 'id' })
    const req: FakeRequest = { params: { id: 'agt_A' } }
    const res = await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    assert.equal(res.subjectAgentId, 'agt_A')
})

test('resolveSubjectAgent path returns null when param missing', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'path', param: 'id' })
    const res = await authz.resolveSubjectAgent(ctxFor(handler), {} as never)
    assert.equal(res.subjectAgentId, null)
})

test('resolveSubjectAgent body reads req.body[field]', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'body', field: 'agentId' })
    const req: FakeRequest = { body: { agentId: 'agt_B' } }
    const res = await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    assert.equal(res.subjectAgentId, 'agt_B')
})

test('resolveSubjectAgent query reads req.query[field]', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'query', field: 'agentId' })
    const req: FakeRequest = { query: { agentId: 'agt_C' } }
    const res = await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    assert.equal(res.subjectAgentId, 'agt_C')
})

test('resolveSubjectAgent list-filtered returns null subject (filter at service layer)', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'list-filtered' })
    const res = await authz.resolveSubjectAgent(ctxFor(handler), {} as never)
    assert.deepEqual(res, {
        classification: { type: 'list-filtered' },
        subjectAgentId: null
    })
})

test('resolveSubjectAgent deny-bound returns null subject', async () => {
    const authz = buildAuthz()
    const handler = declare({ type: 'deny-bound' })
    const res = await authz.resolveSubjectAgent(ctxFor(handler), {} as never)
    assert.deepEqual(res, {
        classification: { type: 'deny-bound' },
        subjectAgentId: null
    })
})

test('resolveSubjectAgent resource dispatches to the right resolver', async () => {
    const channelResolver = makeResolver({ chn_1: 'agt_A' })
    const authz = buildAuthz({ channel: channelResolver })
    const handler = declare({ type: 'resource', kind: 'channel', param: 'id' })
    const req: FakeRequest = {
        params: { id: 'chn_1' },
        auth: { userId: 'user-1' }
    }
    const res = await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    assert.equal(res.subjectAgentId, 'agt_A')
    assert.equal(channelResolver.callCount, 1)
})

test('resolveSubjectAgent resource caches lookups within a request', async () => {
    const channelResolver = makeResolver({ chn_1: 'agt_A' })
    const authz = buildAuthz({ channel: channelResolver })
    const handler = declare({ type: 'resource', kind: 'channel', param: 'id' })
    const req: FakeRequest = {
        params: { id: 'chn_1' },
        auth: { userId: 'user-1' }
    }

    await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    await authz.resolveSubjectAgent(ctxFor(handler), req as never)
    await authz.resolveSubjectAgent(ctxFor(handler), req as never)

    assert.equal(channelResolver.callCount, 1)
    assert.equal(req.resourceAgentCache?.get('channel:chn_1'), 'agt_A')
})

test('resolveSubjectAgent resource returns null when resourceId missing', async () => {
    const channelResolver = makeResolver({})
    const authz = buildAuthz({ channel: channelResolver })
    const handler = declare({ type: 'resource', kind: 'channel', param: 'id' })
    const res = await authz.resolveSubjectAgent(ctxFor(handler), {
        params: {},
        auth: { userId: 'user-1' }
    } as never)
    assert.equal(res.subjectAgentId, null)
    assert.equal(channelResolver.callCount, 0)
})

test('resolveSubjectAgent resource returns null when resolver returns null', async () => {
    const channelResolver = makeResolver({}) // no entries
    const authz = buildAuthz({ channel: channelResolver })
    const handler = declare({ type: 'resource', kind: 'channel', param: 'id' })
    const res = await authz.resolveSubjectAgent(ctxFor(handler), {
        params: { id: 'chn_missing' },
        auth: { userId: 'user-1' }
    } as never)
    assert.equal(res.subjectAgentId, null)
})

test('assertBoundTokenSubject allows when subject matches bound agent', () => {
    const authz = buildAuthz()
    authz.assertBoundTokenSubject('agt_A', {
        classification: { type: 'path', param: 'id' },
        subjectAgentId: 'agt_A'
    })
})

test('assertBoundTokenSubject rejects when subject differs from bound agent', () => {
    const authz = buildAuthz()
    assert.throws(
        () =>
            authz.assertBoundTokenSubject('agt_A', {
                classification: { type: 'path', param: 'id' },
                subjectAgentId: 'agt_B'
            }),
        ForbiddenException
    )
})

test('assertBoundTokenSubject rejects when subject is null', () => {
    const authz = buildAuthz()
    assert.throws(
        () =>
            authz.assertBoundTokenSubject('agt_A', {
                classification: { type: 'path', param: 'id' },
                subjectAgentId: null
            }),
        ForbiddenException
    )
})

test('assertBoundTokenSubject allows list-filtered without checking subject', () => {
    const authz = buildAuthz()
    authz.assertBoundTokenSubject('agt_A', {
        classification: { type: 'list-filtered' },
        subjectAgentId: null
    })
})

test('assertBoundTokenSubject rejects deny-bound', () => {
    const authz = buildAuthz()
    assert.throws(
        () =>
            authz.assertBoundTokenSubject('agt_A', {
                classification: { type: 'deny-bound' },
                subjectAgentId: null
            }),
        ForbiddenException
    )
})

test('assertBoundTokenSubject rejects when no classification declared (default-deny)', () => {
    const authz = buildAuthz()
    assert.throws(
        () =>
            authz.assertBoundTokenSubject('agt_A', {
                classification: null,
                subjectAgentId: null
            }),
        ForbiddenException
    )
})

// ---- account scope (ADR-0010): ownership + subject authorization ----

const authzForOwnership = (ownedRows: Array<{ id: string }>): AuthzService => {
    const empty = makeResolver({})
    const fakeDb = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: () => Promise.resolve(ownedRows)
                })
            })
        })
    }
    return new AuthzService(
        new Reflector(),
        fakeDb as never,
        empty as never,
        empty as never,
        empty as never,
        empty as never,
        empty as never,
        empty as never
    )
}

test('assertAgentOwnedByUser passes when the agent belongs to the user', async () => {
    const authz = authzForOwnership([{ id: 'agt_A' }])
    await authz.assertAgentOwnedByUser('agt_A', 'user-1')
})

test('assertAgentOwnedByUser rejects when the agent is not in the account', async () => {
    const authz = authzForOwnership([])
    await assert.rejects(
        () => authz.assertAgentOwnedByUser('agt_other', 'user-1'),
        /not in this account/
    )
})

test('assertAccountSubject allows account-level classifications without an ownership lookup', async () => {
    // list-filtered / deny-bound / allowlisted carry no per-agent subject; they
    // are user-scoped at the service layer, so no ownership probe
    // (authzForOwnership([]) would reject if the db were consulted).
    const authz = authzForOwnership([])
    await authz.assertAccountSubject(
        { classification: { type: 'list-filtered' }, subjectAgentId: null },
        'user-1'
    )
    await authz.assertAccountSubject(
        { classification: { type: 'deny-bound' }, subjectAgentId: null },
        'user-1'
    )
    await authz.assertAccountSubject(
        {
            classification: { type: 'allowlisted', reason: 'user-level' },
            subjectAgentId: null
        },
        'user-1'
    )
})

test('assertAccountSubject default-denies an undecorated (null classification) endpoint', async () => {
    // Mirrors assertBoundTokenSubject: a missing classification must not become
    // reachable under account scope just because a scope matched.
    const authz = authzForOwnership([{ id: 'agt_A' }])
    await assert.rejects(
        () =>
            authz.assertAccountSubject(
                { classification: null, subjectAgentId: null },
                'user-1'
            ),
        /no subject-agent classification/
    )
})

test('assertAccountSubject enforces intra-user ownership for a subject-bound endpoint', async () => {
    const owned = authzForOwnership([{ id: 'agt_B' }])
    await owned.assertAccountSubject(
        {
            classification: { type: 'path', param: 'id' },
            subjectAgentId: 'agt_B'
        },
        'user-1'
    )
    const notOwned = authzForOwnership([])
    await assert.rejects(
        () =>
            notOwned.assertAccountSubject(
                {
                    classification: { type: 'path', param: 'id' },
                    subjectAgentId: 'agt_other'
                },
                'user-1'
            ),
        /not in this account/
    )
})

test('assertAccountSubject rejects a subject-bound endpoint with no resolved subject', async () => {
    const authz = authzForOwnership([{ id: 'whatever' }])
    await assert.rejects(
        () =>
            authz.assertAccountSubject(
                {
                    classification: {
                        type: 'resource',
                        kind: 'channel',
                        param: 'id'
                    },
                    subjectAgentId: null
                },
                'user-1'
            ),
        /no subject agent/
    )
})
