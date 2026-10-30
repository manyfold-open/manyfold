import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { ConflictException, HttpException } from '@nestjs/common'
import { asc, sql } from 'drizzle-orm'
import {
    agentRuntimes,
    agents,
    auditLogs,
    createDb,
    plans,
    runtimeHosts,
    runtimeProviders,
    users,
    type Database
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import { RuntimeProvidersService } from '../src/modules/hosts/runtime-providers.service'
import {
    ProviderMachineError,
    type MachineUpgradeOutcome,
    type ProviderInventory,
    type ProviderMachine
} from '../src/modules/hosts/providers/sandbox-provider'
import { RuntimeProviderMachinesService } from '../src/modules/runtime-providers/runtime-provider-machines.service'

// A provider's inventory against a real Postgres: which listed machines a
// host here owns (by the name it recorded, or the one derived from its id,
// across every provider row on the same account and no other), what each
// action is allowed to do to a tracked machine, and the audit rows they
// leave. The provider itself is a fake. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/runtime-provider-machines.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

const machine = (
    name: string,
    extra: Partial<ProviderMachine> = {}
): ProviderMachine => ({
    name,
    id: `sprite-${name}`,
    status: 'cold',
    power: 'stopped',
    version: '0.0.1-rc44',
    environmentVersion: null,
    labels: [],
    url: null,
    urlAuth: 'sprite',
    urlPrivateAccess: 'admins',
    createdAt: null,
    updatedAt: null,
    lastRunningAt: null,
    ...extra
})

interface Harness {
    db: Database
    service: RuntimeProviderMachinesService
    ids: {
        user: string
        email: string
        a1: string
        a1Name: string
        a2: string
        b: string
        k8s: string
        recordedHost: string
        derivedHost: string
        derivedName: string
    }
    calls: {
        list: number
        restart: string[]
        destroy: string[]
        deleteHost: string[]
    }
    upgrade: {
        current: ProviderInventory['upgrade']
    }
    restartFails: { current: ProviderMachineError | null }
    audits: () => Promise<
        Array<{
            action: string
            actorId: string | null
            subject: string | null
            meta: Record<string, unknown>
        }>
    >
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const withHarness = (body: (h: Harness) => Promise<void>): Promise<void> =>
    withScratchDatabase('provmach', async ({ url }) => {
        const db = createDb(url, { max: 2 })
        const sfx = randomBytes(6).toString('hex')
        const ids = {
            user: `user_pgtest_${sfx}`,
            email: `${sfx}@pgtest.local`,
            a1: `rtp_pgtest_a1_${sfx}`,
            a1Name: `a-one-${sfx}`,
            a2: `rtp_pgtest_a2_${sfx}`,
            b: `rtp_pgtest_b_${sfx}`,
            k8s: `rtp_pgtest_k8s_${sfx}`,
            recordedHost: `sbx_pgtest_rec_${sfx}`,
            derivedHost: `sbx_pgtest_der_${sfx}`,
            derivedName: `sbx-pgtest-der-${sfx}`
        }
        const calls: Harness['calls'] = {
            list: 0,
            restart: [],
            destroy: [],
            deleteHost: []
        }
        const restartFails: Harness['restartFails'] = { current: null }
        // The organisation-A account: the two hosts' machines, one nobody
        // here owns, and one named like organisation B's host.
        const account = new Map(
            ['sbx-recorded', ids.derivedName, 'sbx-untracked', 'sbx-org-b'].map(
                (name) => [name, machine(name)]
            )
        )
        const upgrade: Harness['upgrade'] = {
            current: async (_p, _name, _req, watch) => {
                watch?.onAccepted?.()
                watch?.onStep?.('starting_machine')
                return {
                    outcome: 'completed',
                    targetVersion: '0.0.2',
                    message: 'Upgrade complete',
                    lastStep: 'completed'
                } satisfies MachineUpgradeOutcome
            }
        }
        const inventory: ProviderInventory = {
            accountKey: (p) => `fake:${(p.config as { orgId?: string }).orgId}`,
            machineNameOf: (host) =>
                host.providerRef && host.providerRef.kind === 'sprites'
                    ? host.providerRef.spriteName
                    : host.id.replace(/_/g, '-'),
            list: async () => {
                calls.list += 1
                return {
                    machines: [...account.values()],
                    complete: true,
                    capacity: null
                }
            },
            get: async (_p, name) => account.get(name) ?? null,
            destroy: async (_p, name) => {
                calls.destroy.push(name)
                account.delete(name)
            },
            restart: async (_p, name) => {
                if (restartFails.current) throw restartFails.current
                calls.restart.push(name)
                return { message: 'Restart requested' }
            },
            upgrade: (...args) => upgrade.current!(...args)
        }
        const registry = {
            has: () => true,
            for: (kind: string) => (kind === 'sprites' ? { inventory } : {})
        }
        const lifecycle = {
            deleteHost: async (hostId: string) => {
                const [row] = await db.execute<{ n: number }>(
                    sql`select count(*)::int as n from agents a join agent_runtimes r on r.id = a.runtime_id where r.host_id = ${hostId}`
                )
                if (Number(row?.n ?? 0) > 0)
                    throw new ConflictException({
                        message: 'host still has agents; delete them first',
                        code: 'HOST_NOT_EMPTY'
                    })
                calls.deleteHost.push(hostId)
            }
        }
        const service = new RuntimeProviderMachinesService(
            db,
            new RuntimeProvidersService(db as never),
            registry as never,
            lifecycle as never
        )
        try {
            await db.insert(plans).values({
                id: `plan_pgtest_${sfx}`,
                name: `pgtest-${sfx}`,
                maxAgentsProvisioned: 3,
                maxConcurrentActive: 1,
                maxStorageGb: 3
            })
            await db.insert(users).values({
                id: ids.user,
                email: ids.email,
                planId: `plan_pgtest_${sfx}`
            })
            const provider = (
                id: string,
                name: string,
                orgId: string,
                kind = 'sprites'
            ) => ({
                id,
                kind: kind as 'sprites' | 'k8s',
                name,
                credentialCiphertext: 'encrypted',
                config: { orgSlug: name, orgId, tokenId: 't' }
            })
            await db
                .insert(runtimeProviders)
                .values([
                    provider(ids.a1, ids.a1Name, 'org-a'),
                    provider(ids.a2, `a-two-${sfx}`, 'org-a'),
                    provider(ids.b, `b-${sfx}`, 'org-b'),
                    provider(ids.k8s, `k8s-${sfx}`, 'cluster', 'k8s')
                ])
            const host = (
                id: string,
                providerId: string,
                spriteName: string | null,
                status: 'ready' | 'provisioning'
            ) => ({
                id,
                userId: ids.user,
                kind: 'hosted' as const,
                providerId,
                providerRef: spriteName
                    ? { kind: 'sprites' as const, spriteName, spriteId: null }
                    : null,
                name: `sandbox-${id}`,
                status
            })
            await db
                .insert(runtimeHosts)
                .values([
                    host(ids.recordedHost, ids.a1, 'sbx-recorded', 'ready'),
                    host(ids.derivedHost, ids.a2, null, 'provisioning'),
                    host(`sbx_pgtest_b_${sfx}`, ids.b, 'sbx-org-b', 'ready')
                ])
            await db.insert(agentRuntimes).values({
                id: `art_pgtest_${sfx}`,
                userId: ids.user,
                name: `pgtest-runtime-${sfx}`,
                framework: 'claude-code',
                hostId: ids.recordedHost
            })
            await db.insert(agents).values({
                id: `agt_pgtest_${sfx}`,
                userId: ids.user,
                name: `pgtest-agent-${sfx}`,
                framework: 'claude-code',
                runtimeId: `art_pgtest_${sfx}`,
                internalId: `internal-${sfx}`
            })
            await body({
                db,
                service,
                ids,
                calls,
                upgrade,
                restartFails,
                audits: async () =>
                    (
                        await db
                            .select()
                            .from(auditLogs)
                            .orderBy(asc(auditLogs.createdAt))
                    ).map((row) => ({
                        action: row.action,
                        actorId: row.actorId,
                        subject: row.subject,
                        meta: (row.meta ?? {}) as Record<string, unknown>
                    }))
            })
        } finally {
            await closeDb(db)
        }
    })

const codeOf = async (
    call: Promise<unknown>
): Promise<{ status: number; code: string }> => {
    try {
        await call
    } catch (err) {
        assert.ok(err instanceof HttpException, `not an HttpException: ${err}`)
        const body = err.getResponse() as { code?: string }
        return { status: err.getStatus(), code: body.code ?? '' }
    }
    throw new Error('expected a rejection')
}

test(
    'a listing marks the machines a host here owns, across the account and no further',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const list = await h.service.list(h.ids.a1)

            const byName = new Map(list.machines.map((m) => [m.name, m.host]))
            assert.deepEqual(byName.get('sbx-recorded'), {
                id: h.ids.recordedHost,
                name: `sandbox-${h.ids.recordedHost}`,
                status: 'ready',
                userId: h.ids.user,
                ownerEmail: h.ids.email,
                agentsCount: 1,
                providerId: h.ids.a1,
                providerName: h.ids.a1Name
            })
            // Never recorded: still the host's, under the name it would have.
            assert.equal(byName.get(h.ids.derivedName)?.id, h.ids.derivedHost)
            assert.equal(byName.get(h.ids.derivedName)?.providerId, h.ids.a2)
            assert.equal(byName.get('sbx-untracked'), null)
            // Organisation B's host is not this account's.
            assert.equal(byName.get('sbx-org-b'), null)
            assert.deepEqual(
                list.sharedWith.map((row) => row.id),
                [h.ids.a2]
            )
            assert.equal(list.complete, true)

            // Shared for a while, re-read on request, forgotten after an action.
            await h.service.list(h.ids.a2)
            assert.equal(h.calls.list, 1)
            await h.service.list(h.ids.a1, { refresh: true })
            assert.equal(h.calls.list, 2)
            await h.service.restart(h.ids.user, h.ids.a1, 'sbx-untracked')
            await h.service.list(h.ids.a1)
            assert.equal(h.calls.list, 3)

            assert.deepEqual(await codeOf(h.service.list(h.ids.k8s)), {
                status: 409,
                code: 'RUNTIME_PROVIDER_INVENTORY_UNSUPPORTED'
            })
        })
)

test(
    'restart and upgrade are audited, and refused under a host being made',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await h.service.restart(h.ids.user, h.ids.a1, 'sbx-untracked')
            await h.service.restart(h.ids.user, h.ids.a1, 'sbx-recorded')
            assert.deepEqual(
                await codeOf(
                    h.service.restart(h.ids.user, h.ids.a1, h.ids.derivedName)
                ),
                {
                    status: 409,
                    code: 'PROVIDER_MACHINE_HOST_BUSY'
                }
            )
            assert.deepEqual(h.calls.restart, ['sbx-untracked', 'sbx-recorded'])

            const accepted: Array<string | null> = []
            const steps: string[] = []
            const result = await h.service.upgrade(
                h.ids.user,
                h.ids.a2,
                'sbx-untracked',
                { allowStorageMigration: true },
                {
                    onAccepted: (from) => accepted.push(from),
                    onStep: (step) => steps.push(step)
                }
            )
            assert.deepEqual(result, {
                outcome: 'completed',
                message: 'Upgrade complete',
                fromVersion: '0.0.1-rc44',
                targetVersion: '0.0.2',
                lastStep: 'completed'
            })
            assert.deepEqual(accepted, ['0.0.1-rc44'])
            assert.deepEqual(steps, ['starting_machine'])

            const rows = await h.audits()
            assert.deepEqual(
                rows.map((row) => [row.action, row.subject]),
                [
                    [
                        'runtime_provider.machine.restarted',
                        `machine:${h.ids.a1}/sbx-untracked`
                    ],
                    [
                        'runtime_provider.machine.restarted',
                        `machine:${h.ids.a1}/sbx-recorded`
                    ],
                    [
                        'runtime_provider.machine.upgrade.started',
                        `machine:${h.ids.a2}/sbx-untracked`
                    ],
                    [
                        'runtime_provider.machine.upgrade.succeeded',
                        `machine:${h.ids.a2}/sbx-untracked`
                    ]
                ]
            )
            for (const row of rows)
                assert.equal(row.actorId, `user:${h.ids.user}`)
            assert.equal(rows[0].meta.hostId, null)
            assert.equal(rows[1].meta.hostId, h.ids.recordedHost)
            assert.deepEqual(rows[2].meta, {
                providerId: h.ids.a2,
                providerKind: 'sprites',
                machineName: 'sbx-untracked',
                hostId: null,
                hostUserId: null,
                fromVersion: '0.0.1-rc44',
                requestedVersion: null,
                allowStorageMigration: true
            })
            assert.equal(rows[3].meta.targetVersion, '0.0.2')

            // Under either row of the account, newest first, with who did it.
            const actions = await h.service.actions(h.ids.a1, 'sbx-untracked')
            assert.deepEqual(
                actions.map((a) => a.action),
                [
                    'runtime_provider.machine.upgrade.succeeded',
                    'runtime_provider.machine.upgrade.started',
                    'runtime_provider.machine.restarted'
                ]
            )
            assert.equal(actions[0].actorEmail, h.ids.email)
        })
)

test(
    'an upgrade refused before it starts, or left unwatched, writes no end',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            h.upgrade.current = async () => {
                throw new ProviderMachineError(
                    'storage_migration_required',
                    'this upgrade would move the sprite from sbd to juicefs storage'
                )
            }
            assert.deepEqual(
                await codeOf(
                    h.service.upgrade(h.ids.user, h.ids.a1, 'sbx-untracked', {})
                ),
                {
                    status: 409,
                    code: 'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED'
                }
            )
            assert.deepEqual(await h.audits(), [])

            h.upgrade.current = async (_p, _n, _r, watch) => {
                watch?.onAccepted?.()
                return {
                    outcome: 'unconfirmed',
                    targetVersion: '0.0.2',
                    message: null,
                    lastStep: 'starting_machine'
                }
            }
            const result = await h.service.upgrade(
                h.ids.user,
                h.ids.a1,
                'sbx-untracked',
                {}
            )
            assert.equal(result.outcome, 'unconfirmed')
            assert.deepEqual(
                (await h.audits()).map((row) => row.action),
                ['runtime_provider.machine.upgrade.started']
            )

            h.restartFails.current = new ProviderMachineError(
                'rate_limited',
                'slow down',
                6500
            )
            const limited = await h.service
                .restart(h.ids.user, h.ids.a1, 'sbx-untracked')
                .catch((err: HttpException) => err)
            assert.ok(limited instanceof HttpException)
            assert.equal(limited.getStatus(), 429)
            assert.equal(
                (limited.getResponse() as { retryAfterSec: number })
                    .retryAfterSec,
                7
            )
        })
)

test(
    'a tracked machine is deleted as its sandbox, an untracked one at the provider',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            // Agents still on it: refused, untouched, not audited.
            assert.deepEqual(
                await codeOf(
                    h.service.delete(h.ids.user, h.ids.a1, 'sbx-recorded')
                ),
                {
                    status: 409,
                    code: 'HOST_NOT_EMPTY'
                }
            )
            await h.service.delete(h.ids.user, h.ids.a1, h.ids.derivedName)
            await h.service.delete(h.ids.user, h.ids.a1, 'sbx-untracked')
            assert.deepEqual(
                await codeOf(
                    h.service.delete(h.ids.user, h.ids.a1, 'sbx-never')
                ),
                {
                    status: 404,
                    code: 'PROVIDER_MACHINE_NOT_FOUND'
                }
            )

            assert.deepEqual(h.calls.deleteHost, [h.ids.derivedHost])
            assert.deepEqual(h.calls.destroy, ['sbx-untracked'])
            const rows = await h.audits()
            assert.deepEqual(
                rows.map((row) => [
                    row.meta.machineName,
                    row.meta.via,
                    row.meta.hostId
                ]),
                [
                    [h.ids.derivedName, 'host_lifecycle', h.ids.derivedHost],
                    ['sbx-untracked', 'provider', null]
                ]
            )
        })
)

test(
    'an action still happens when its audit row cannot be written',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await h.db.execute(
                sql`alter table audit_logs rename to audit_logs_away`
            )
            const result = await h.service.restart(
                h.ids.user,
                h.ids.a1,
                'sbx-untracked'
            )
            assert.deepEqual(result, { message: 'Restart requested' })
            assert.deepEqual(h.calls.restart, ['sbx-untracked'])
        })
)
