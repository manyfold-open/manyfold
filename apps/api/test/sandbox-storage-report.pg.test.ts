import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { eq } from 'drizzle-orm'
import { agentPermissions, runtimeHosts, type Database } from '@manyfold/db'
import { ACCOUNT_SCOPE_HEADER, createObjectId } from '@manyfold/shared'
import { AuthGuard, type AuthPrincipal } from '../src/common/guards/auth.guard'
import { AuthzService } from '../src/modules/auth/authz.service'
import { RuntimeAccessController } from '../src/modules/runtime-access/runtime-access.controller'
import { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import { storageFixture, OLD, waitFor } from './helpers/storage-fixture'

const RUN = process.env.RUN_PG_E2E === '1'

test('self config attribution requires an explicit agent relationship, not a matching framework', { skip: !RUN, timeout: 20_000 }, async (t) => {
    const h = await storageFixture(t)
    const own = await h.addAgent({ framework: 'openclaw', config: '/fixture/own-config' })
    const peer = await h.addAgent({ framework: 'openclaw', config: '/fixture/private-peer-config' })
    await h.db.update(runtimeHosts).set({ storageBreakdown: {
        formatVersion: 1, vmUsedBytes: 9000, measuredVia: 'df', attributionComplete: false,
        workspaces: [{ agentId: own.id, bytes: 500, attributedBytes: 500 }],
        homes: [
            { framework: 'openclaw', path: own.mountPath, bytes: 100, attributedBytes: 100, agentIds: [own.id] },
            { framework: 'openclaw', path: peer.mountPath, bytes: 200, attributedBytes: 200, agentIds: [peer.id] },
            { framework: 'openclaw', bytes: 300 }
        ]
    } }).where(eq(runtimeHosts.id, h.hostId))
    const self = await h.access.sandboxUsage(h.userId, own.id)
    assert.deepEqual(self.hosts[0].homes.map((home) => home.path), [own.mountPath])
    assert.equal(self.storageBytesTotal, 9000)
    assert(!JSON.stringify(self).includes(peer.id))
    assert(!JSON.stringify(self).includes(peer.mountPath))
    const account = await h.access.sandboxUsage(h.userId)
    assert.equal(account.hosts[0].homes.length, 3)
    const legacy = account.hosts[0].homes.find((home) => home.path === null)
    assert.equal(legacy?.measuredBytes, 300)
    assert.equal(legacy?.bytes, null, 'legacy raw measurement does not prove overlap-free attribution')
})

test(
    'account report ranks cached cold and standalone hosts and reconciles its own snapshot total',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await storageFixture(t)
        const a = await h.addAgent({ name: 'first' })
        const b = await h.addAgent({ name: 'second' })
        await h.db
            .update(runtimeHosts)
            .set({
                name: 'A-small',
                storageBreakdown: {
                    formatVersion: 1,
                    vmUsedBytes: 9000,
                    measuredVia: 'df',
                    homes: [],
                    workspaces: [
                        { agentId: a.id, bytes: 100, attributedBytes: 100 },
                        { agentId: b.id, bytes: 200, attributedBytes: 200 }
                    ],
                    attributionComplete: true
                }
            })
            .where(eq(runtimeHosts.id, h.hostId))
        const large = await h.addHost({
            name: 'Z-large',
            spriteStatus: 'cold',
            storageBytes: 18000,
            storageMeasuredAt: OLD,
            storageBreakdown: {
                formatVersion: 1,
                vmUsedBytes: 18000,
                measuredVia: 'df',
                homes: [],
                workspaces: [],
                attributionComplete: true
            }
        })
        const report = await h.access.sandboxUsage(h.userId)
        assert.equal(report.scope, 'account')
        assert.equal(report.unit, 'bytes')
        assert.equal(report.storageBytesTotal, 27000)
        assert.equal(
            report.storageBytesTotal,
            report.hosts.reduce(
                (total, host) => total + (host.storageBytes ?? 0),
                0
            )
        )
        assert.equal(
            report.storageBytesTotal,
            (await h.access.summary(h.userId)).storageBytesTotal
        )
        assert.deepEqual(
            report.hosts.map((host) => host.hostId),
            [large.id, h.hostId]
        )
        assert.equal(report.hosts[0].asleep, true)
        assert.equal(report.hosts[0].storageFreshness, 'stale')
        assert.equal(report.hosts[0].storageBytes, 18000)
        assert.deepEqual(report.hosts[0].agents, [])
        assert.equal(report.hosts[1].agents.length, 2)
        assert.equal(report.hosts[1].runtimes.length, 1)
        assert.equal(
            report.storageFreshness.oldestMeasuredAt,
            OLD.toISOString()
        )
        assert.equal(
            h.sockets.length,
            0,
            'reporting must never exec or wake a sandbox'
        )
    }
)

test(
    'real authz grants account storage only with intent and keeps self/co-resident/foreign boundaries',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await storageFixture(t)
        const own = await h.addAgent({ name: 'current-agent' })
        const peer = await h.addAgent({ name: 'private-co-resident-name' })
        const another = await h.addHost({
            name: 'other-own-host',
            storageBytes: 1000
        })
        const foreignUser = await h.addUser()
        const foreignHost = await h.addHost({
            userId: foreignUser,
            name: 'private-foreign-host',
            storageBytes: 1000000
        })
        const foreign = await h.addAgent({
            userId: foreignUser,
            hostId: foreignHost.id,
            name: 'private-foreign-agent'
        })
        const grantId = createObjectId('agentPermission')
        await h.db
            .insert(agentPermissions)
            .values({
                id: grantId,
                agentId: own.id,
                userId: h.userId,
                scopes: ['agents:read']
            })
        const reflector = new Reflector()
        const authz = new AuthzService(
            reflector,
            h.db,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never
        )
        const guard = new AuthGuard(
            {
                verifyBearerToken: async () => ({
                    kind: 'agent-runtime',
                    userId: h.userId,
                    agentId: own.id
                })
            } as never,
            reflector,
            authz
        )
        const controller = new RuntimeAccessController(
            h.access,
            { upsertUser: async () => {} } as never,
            { getUserEmail: async () => null } as never
        )
        const request = async (account: boolean, agentId?: string) => {
            const req = {
                headers: {
                    authorization: 'Bearer owned-fixture',
                    ...(account ? { [ACCOUNT_SCOPE_HEADER]: '1' } : {})
                },
                params: { agentId },
                auth: undefined as AuthPrincipal | undefined
            }
            const handler = agentId
                ? RuntimeAccessController.prototype.agentSandboxUsage
                : RuntimeAccessController.prototype.sandboxUsage
            await guard.canActivate({
                switchToHttp: () => ({ getRequest: () => req }),
                getClass: () => RuntimeAccessController,
                getHandler: () => handler
            } as unknown as ExecutionContext)
            assert(req.auth)
            return agentId
                ? controller.agentSandboxUsage(req.auth, agentId)
                : controller.sandboxUsage(req.auth)
        }
        await assert.rejects(request(false), /bound token/)
        const self = await request(false, own.id)
        assert.equal(self.scope, 'sandbox')
        assert.equal(self.attributionScope, 'agent')
        assert.deepEqual(
            self.hosts.map((host) => host.hostId),
            [h.hostId]
        )
        assert.deepEqual(
            self.hosts[0].agents.map((agent) => agent.agentId),
            [own.id]
        )
        for (const hidden of [
            peer.id,
            peer.name,
            another.id,
            foreignHost.id,
            foreign.id,
            foreign.name
        ])
            assert.equal(JSON.stringify(self).includes(hidden), false)
        await assert.rejects(request(false, peer.id), /token bound/)
        await assert.rejects(request(true, foreign.id))
        const account = await request(true)
        assert.equal(account.scope, 'account')
        assert.equal(account.hosts.length, 2)
        assert.equal(
            account.hosts.find((host) => host.hostId === h.hostId)?.agents
                .length,
            2
        )
        assert.equal(JSON.stringify(account).includes(foreignHost.id), false)
        await h.db
            .update(agentPermissions)
            .set({ scopes: [] })
            .where(eq(agentPermissions.id, grantId))
        await assert.rejects(
            request(true),
            /agent permission missing scope: one of \[agents:read\]/
        )
        assert.equal((await request(false, own.id)).scope, 'sandbox')
        assert.equal(h.sockets.length, 0)
    }
)

test(
    'storage total and freshness retain one actual repeatable-read snapshot across a publication',
    { skip: !RUN, timeout: 20_000 },
    async (t) => {
        const h = await storageFixture(t)
        let entered = false
        let release!: () => void
        const barrier = new Promise<void>((resolve) => {
            release = resolve
        })
        t.after(() => release())
        const db = new Proxy(h.db, {
            get(target, property, receiver) {
                if (property !== 'transaction')
                    return Reflect.get(target, property, receiver)
                return (
                    work: (tx: unknown) => Promise<unknown>,
                    config: unknown
                ) =>
                    target.transaction(async (tx) => {
                        let first = true
                        return work(
                            new Proxy(tx, {
                                get(transaction, key, proxyReceiver) {
                                    if (key !== 'execute')
                                        return Reflect.get(
                                            transaction,
                                            key,
                                            proxyReceiver
                                        )
                                    return async (
                                        ...args: Parameters<typeof tx.execute>
                                    ) => {
                                        const result =
                                            await transaction.execute(...args)
                                        if (first) {
                                            first = false
                                            entered = true
                                            await barrier
                                        }
                                        return result
                                    }
                                }
                            })
                        )
                    }, config as never)
            }
        }) as Database
        const access = Object.assign(
            Object.create(RuntimeAccessService.prototype),
            h.access,
            { db }
        ) as RuntimeAccessService
        const pending = access.sandboxUsage(h.userId)
        void pending.catch(() => undefined)
        try {
            await waitFor(() => entered)
            await h.db
                .update(runtimeHosts)
                .set({ storageBytes: 77000, storageMeasuredAt: new Date() })
                .where(eq(runtimeHosts.id, h.hostId))
        } finally {
            release()
        }
        const report = await pending
        assert.equal(report.storageBytesTotal, 9000)
        assert.equal(report.hosts[0].storageBytes, 9000)
        assert.equal(
            report.storageFreshness.oldestMeasuredAt,
            OLD.toISOString()
        )
        assert.equal(
            (await h.access.summary(h.userId)).storageBytesTotal,
            77000,
            'a later summary is deliberately a different snapshot'
        )
    }
)
