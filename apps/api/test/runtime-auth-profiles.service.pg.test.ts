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
    createDb,
    plans,
    runtimeAuthOperations,
    runtimeAuthProfiles,
    runtimeHosts,
    users,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    DAEMON_FEATURE_AUTH_API_KEY,
    DAEMON_FEATURE_AUTH_PROFILES,
    RUNTIME_AUTH_ERROR,
    type DaemonAuthListResponse,
    type RuntimeAccountProbe
} from '@manyfold/shared'
import type { AuthPrincipal } from '@/common/guards/auth.guard'
import { RuntimeAuthProfilesService } from '@/modules/agent-runtimes/auth/runtime-auth-profiles.service'
import { RuntimeAccountService } from '@/modules/agent-runtimes/account/runtime-account.service'

// Run with:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://… node --import tsx --test test/runtime-auth-profiles.service.pg.test.ts
// against a migrated (0009+) throwaway database. The daemon is a fake that
// records RPCs and answers with canned reports; everything the service
// persists — profile projection, operations, the RESTRICT binding — is real.

const RUN = process.env.RUN_PG_E2E === '1'

const probeFor = (email: string): RuntimeAccountProbe => ({
    framework: 'codex',
    checkedAt: '2026-09-09T20:00:00.000Z',
    credentialFacts: {
        framework: 'codex',
        authFilePresent: true,
        authFileParsed: true,
        apiKeyPresent: false,
        envApiKey: false,
        hasAccessToken: true,
        hasRefreshToken: true,
        accessTokenExp: Date.now() + 600_000,
        lastRefresh: null,
        customProviders: [],
        activeProvider: null
    },
    tokenSource: 'file',
    identity: {
        email,
        name: null,
        organization: null,
        plan: 'pro',
        accountId: 'acct-1'
    },
    usage: null
})

interface Harness {
    db: Database
    service: RuntimeAuthProfilesService
    principal: AuthPrincipal
    userId: string
    runtimeId: string
    hostId: string
    rpcs: Array<{ method: string; payload: Record<string, unknown> }>
    setOnline: (online: boolean) => void
    setFeatures: (features: string[]) => Promise<void>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const userId = `user_rap_${suffix}`
    const planId = `plan_rap_${suffix}`
    const hostId = `dh_rap${suffix}`
    const runtimeId = `art_rap${suffix}`
    await db.insert(plans).values({
        id: planId,
        name: `rap ${suffix}`,
        maxAgentsProvisioned: 5,
        maxConcurrentActive: 5,
        maxStorageGb: 100,
        monthlyApiRequestLimit: null
    })
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@rap.local`, planId })
    await db.insert(runtimeHosts).values({
        id: hostId,
        userId,
        kind: 'daemon',
        name: `rap-host-${suffix}`,
        status: 'active',
        clientFeatures: [DAEMON_FEATURE_AUTH_PROFILES],
        rpcLastSeenAt: new Date()
    } as never)
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `rap-runtime-${suffix}`,
        framework: 'codex',
        kind: 'daemon',
        status: 'ready',
        daemonId: hostId,
        hostId
    } as never)

    const rpcs: Harness['rpcs'] = []
    let online = true
    const hostRow = async (): Promise<RuntimeHostRow | null> =>
        (
            await db
                .select()
                .from(runtimeHosts)
                .where(eq(runtimeHosts.id, hostId))
                .limit(1)
        )[0] ?? null
    const daemonHosts = {
        findById: hostRow,
        isOnline: () => online
    }
    const daemonRegistry = {
        rpc: async (args: {
            method: string
            payload: Record<string, unknown>
        }) => {
            rpcs.push({ method: args.method, payload: args.payload })
            const listed = await db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.runtimeId, runtimeId))
            if (args.method === 'auth.list')
                return {
                    profiles: listed
                        .filter((row) => row.lifecycle !== 'deleted')
                        .map((row) => ({
                            profileId: row.id,
                            present: true,
                            authMethod: row.authMethod,
                            generation: row.credentialGeneration + 1,
                            createdAt: row.createdAt.toISOString(),
                            lastLoginAt: null,
                            probe: probeFor(`${row.label}@vendor.local`),
                            error: null
                        })),
                    ambient: probeFor('native@vendor.local')
                } satisfies DaemonAuthListResponse
            if (args.method === 'auth.create')
                return {
                    profileId: args.payload.profileId,
                    generation: 0,
                    created: true
                }
            if (args.method === 'auth.inspect')
                return {
                    profileId: args.payload.profileId,
                    present: true,
                    authMethod: 'subscription',
                    generation: 3,
                    createdAt: null,
                    lastLoginAt: null,
                    probe: probeFor('inspected@vendor.local'),
                    error: null
                }
            if (args.method === 'auth.logout')
                return {
                    signedOut: true,
                    removed: args.payload.mode === 'remove',
                    revoke: 'unknown',
                    generation: 9,
                    logoutError: null
                }
            throw new Error(`unexpected rpc ${args.method}`)
        }
    }
    const runtimes = {
        findById: async (id: string) =>
            (
                await db
                    .select()
                    .from(agentRuntimes)
                    .where(eq(agentRuntimes.id, id))
                    .limit(1)
            )[0] ?? null
    }
    const account = new RuntimeAccountService(
        runtimes as never,
        daemonHosts as never,
        daemonRegistry as never,
        {} as never,
        {} as never
    )
    // The sprite-only collaborators (sandbox admission, sprites.dev account,
    // runner wake) are never reached by a daemon runtime.
    const service = new RuntimeAuthProfilesService(
        db,
        runtimes as never,
        daemonHosts as never,
        daemonRegistry as never,
        account,
        {} as never,
        {} as never,
        {} as never
    )
    const principal = {
        userId,
        kind: 'human-session'
    } as unknown as AuthPrincipal
    return {
        db,
        service,
        principal,
        userId,
        runtimeId,
        hostId,
        rpcs,
        setOnline: (value) => {
            online = value
        },
        setFeatures: async (features) => {
            await db
                .update(runtimeHosts)
                .set({ clientFeatures: features })
                .where(eq(runtimeHosts.id, hostId))
        },
        close: async () => {
            await db.delete(users).where(eq(users.id, userId))
            await db.delete(plans).where(eq(plans.id, planId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            await client?.end?.()
        }
    }
}

test(
    'create → list projects the host report, keeps the ambient account read-only, and scopes by owner',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const created = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'subscription',
                label: 'work'
            })
            assert.equal(created.lifecycle, 'pending')
            assert.equal(created.label, 'work')
            assert.match(created.id, /^rap_/)
            assert.deepEqual(
                h.rpcs.map((r) => r.method),
                ['auth.create']
            )
            assert.equal(h.rpcs[0].payload.profileId, created.id)

            const listed = await h.service.list(h.userId, h.runtimeId)
            assert.equal(listed.availability, 'ok')
            assert.equal(listed.capabilities.manage, true)
            assert.equal(
                listed.capabilities.execute,
                false,
                'listing never implies executing'
            )
            assert.equal(listed.profiles.length, 1)
            const [profile] = listed.profiles
            assert.equal(
                profile.lifecycle,
                'ready',
                'a signed-in pending profile becomes ready'
            )
            assert.equal(profile.credentialStatus, 'valid')
            assert.equal(profile.identity?.email, 'work@vendor.local')
            assert.equal(profile.credentialGeneration, 1)
            assert.equal(listed.ambient?.identity?.email, 'native@vendor.local')
            assert.equal(listed.ambient?.status, 'ok')

            // Persisted, not just rendered.
            const [row] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, profile.id))
            assert.equal(row.email, 'work@vendor.local')
            assert.equal(row.vendor, 'openai')

            // Another user gets a uniform not-found, never the profile.
            await assert.rejects(
                h.service.list('user_other', h.runtimeId),
                /not found/
            )
            await assert.rejects(
                h.service.inspect('user_other', h.runtimeId, profile.id),
                /not found/
            )

            // api-key profiles need the key up front and a host that stores it;
            // the key is forwarded once and never lands in the row.
            await assert.rejects(
                h.service.create(h.principal, h.runtimeId, {
                    authMethod: 'api-key'
                }),
                (err: { status?: number }) => err.status === 400
            )
            await assert.rejects(
                h.service.create(h.principal, h.runtimeId, {
                    authMethod: 'api-key',
                    apiKey: 'runtime-local-key-fixture'
                }),
                (err: { response?: { code?: string } }) =>
                    err.response?.code ===
                    RUNTIME_AUTH_ERROR.daemonUpgradeRequired
            )
            await h.setFeatures([
                DAEMON_FEATURE_AUTH_PROFILES,
                DAEMON_FEATURE_AUTH_API_KEY
            ])
            const keyed = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'api-key',
                apiKey: 'runtime-local-key-fixture',
                label: 'Work key'
            })
            assert.equal(keyed.authMethod, 'api-key')
            assert.equal(keyed.lifecycle, 'ready')
            assert.equal(keyed.credentialStatus, 'valid')
            const keyedCreate = h.rpcs.find(
                (r) =>
                    r.method === 'auth.create' &&
                    r.payload.profileId === keyed.id
            )
            assert.equal(
                keyedCreate?.payload.apiKey,
                'runtime-local-key-fixture'
            )
            const [keyedRow] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, keyed.id))
            assert.equal(
                JSON.stringify(keyedRow).includes('runtime-local-key'),
                false,
                'the API never persists the key'
            )
            await assert.rejects(
                h.service.startLogin(h.principal, h.runtimeId, keyed.id, {}),
                (err: { response?: { code?: string } }) =>
                    err.response?.code === RUNTIME_AUTH_ERROR.stateConflict
            )
            await h.setFeatures([DAEMON_FEATURE_AUTH_PROFILES])
        } finally {
            await h.close()
        }
    }
)

test(
    'availability degrades without a silent fallback: offline, missing capability, agent principal',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            h.setOnline(false)
            const offline = await h.service.list(h.userId, h.runtimeId)
            assert.equal(offline.availability, 'daemon-offline')
            assert.equal(offline.capabilities.manage, false)
            await assert.rejects(
                h.service.create(h.principal, h.runtimeId, {
                    authMethod: 'subscription'
                }),
                (err: { response?: { code?: string } }) =>
                    err.response?.code === RUNTIME_AUTH_ERROR.hostUnavailable
            )
            h.setOnline(true)
            await h.setFeatures(['account.inspect'])
            const old = await h.service.list(h.userId, h.runtimeId)
            assert.equal(old.availability, 'daemon-upgrade-required')
            await assert.rejects(
                h.service.create(h.principal, h.runtimeId, {
                    authMethod: 'subscription'
                }),
                (err: { response?: { code?: string } }) =>
                    err.response?.code ===
                    RUNTIME_AUTH_ERROR.daemonUpgradeRequired
            )
            await h.setFeatures([DAEMON_FEATURE_AUTH_PROFILES])
            const agentPrincipal = {
                userId: h.userId,
                kind: 'agent-runtime'
            } as unknown as AuthPrincipal
            await assert.rejects(
                h.service.create(agentPrincipal, h.runtimeId, {
                    authMethod: 'subscription'
                }),
                (err: { status?: number }) => err.status === 403
            )
            assert.deepEqual(
                h.rpcs,
                [],
                'no host call was made for any refused request'
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'logout keeps the row, remove tombstones it, and a bound agent or default blocks removal (FK RESTRICT included)',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const profile = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'subscription'
            })
            const other = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'subscription'
            })
            assert.equal(other.label, 'Account 2')

            const agentId = `agt_rap${randomBytes(6).toString('hex')}`
            await h.db.insert(agents).values({
                id: agentId,
                userId: h.userId,
                name: 'bound',
                framework: 'codex',
                runtime: 'daemon',
                runtimeId: h.runtimeId,
                internalId: agentId,
                runtimeAuthProfileId: profile.id
            } as never)

            // The database itself refuses to orphan the binding.
            await assert.rejects(
                h.db
                    .delete(runtimeAuthProfiles)
                    .where(eq(runtimeAuthProfiles.id, profile.id)),
                /restrict|violates foreign key/i
            )
            const inUse = await assert.rejects(
                h.service.remove(h.principal, h.runtimeId, profile.id, {}),
                (err: {
                    response?: { code?: string; agents?: Array<{ id: string }> }
                }) =>
                    err.response?.code === RUNTIME_AUTH_ERROR.inUse &&
                    err.response.agents?.[0]?.id === agentId
            )
            void inUse
            const listed = await h.service.list(h.userId, h.runtimeId)
            assert.equal(
                listed.profiles.find((p) => p.id === profile.id)?.agentCount,
                1
            )

            // Sign-out is allowed while bound: the agent is marked reauth, not moved.
            const logout = await h.service.logout(
                h.principal,
                h.runtimeId,
                profile.id,
                { requestId: 'req-1' }
            )
            assert.equal(logout.status, 'succeeded')
            assert.equal(logout.kind, 'logout')
            assert.equal(logout.revoke, 'unknown')
            const again = await h.service.logout(
                h.principal,
                h.runtimeId,
                profile.id,
                { requestId: 'req-1' }
            )
            assert.equal(
                again.id,
                logout.id,
                'same requestId → same operation, no second vendor call'
            )
            assert.equal(
                h.rpcs.filter((r) => r.method === 'auth.logout').length,
                1
            )
            const [signedOut] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, profile.id))
            assert.equal(signedOut.lifecycle, 'signed-out')
            assert.equal(signedOut.credentialStatus, 'missing')
            assert.equal(signedOut.credentialGeneration, 9)

            // Default blocks removal too; clearing it unblocks.
            await h.service.setDefault(h.principal, h.runtimeId, other.id)
            await assert.rejects(
                h.service.remove(h.principal, h.runtimeId, other.id, {}),
                (err: { response?: { code?: string } }) =>
                    err.response?.code === RUNTIME_AUTH_ERROR.inUse
            )
            const cleared = await h.service.setDefault(
                h.principal,
                h.runtimeId,
                null
            )
            assert.equal(cleared.defaultProfileId, null)
            const removed = await h.service.remove(
                h.principal,
                h.runtimeId,
                other.id,
                {}
            )
            assert.equal(removed.status, 'succeeded')
            assert.equal(removed.kind, 'remove')
            const [tomb] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, other.id))
            assert.equal(tomb.lifecycle, 'deleted')
            assert.ok(tomb.deletedAt)
            const after = await h.service.list(h.userId, h.runtimeId)
            assert.deepEqual(
                after.profiles.map((p) => p.id),
                [profile.id],
                'tombstones are not listed'
            )
            await assert.rejects(
                h.service.inspect(h.userId, h.runtimeId, other.id),
                /not found/
            )
            const ops = await h.db
                .select()
                .from(runtimeAuthOperations)
                .where(eq(runtimeAuthOperations.runtimeId, h.runtimeId))
            assert.deepEqual(ops.map((o) => o.kind).sort(), [
                'logout',
                'remove'
            ])
        } finally {
            await h.close()
        }
    }
)

test(
    'login mints an operation the terminal attaches to, and reconcile folds the host verdict back',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const profile = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'subscription'
            })
            const op = await h.service.startLogin(
                h.principal,
                h.runtimeId,
                profile.id,
                { requestId: 'login-1' }
            )
            assert.equal(op.status, 'pending')
            assert.equal(op.kind, 'login')
            assert.ok(op.deadlineAt)
            const same = await h.service.startLogin(
                h.principal,
                h.runtimeId,
                profile.id,
                { requestId: 'login-1' }
            )
            assert.equal(same.id, op.id)
            const target = await h.service.loginTarget(h.userId, op.id)
            assert.deepEqual(target.authLogin, {
                framework: 'codex',
                runtimeId: h.runtimeId,
                profileId: profile.id,
                operationId: op.id
            })
            assert.equal(
                (await h.service.operation(h.userId, op.id)).status,
                'running'
            )
            await assert.rejects(
                h.service.loginTarget('user_other', op.id),
                /not found/
            )

            // Host says the shell stored a credential.
            const registry = (
                h.service as unknown as {
                    daemonRegistry: {
                        rpc: (a: {
                            method: string
                            payload: Record<string, unknown>
                        }) => Promise<unknown>
                    }
                }
            ).daemonRegistry
            const original = registry.rpc
            registry.rpc = async (args) => {
                if (args.method === 'auth.operation')
                    return {
                        operationId: args.payload.operationId,
                        profileId: profile.id,
                        kind: 'login',
                        status: 'succeeded',
                        resultCode: null,
                        error: null,
                        startedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    }
                return original(args)
            }
            await h.service.reconcileLogin(h.userId, op.id)
            assert.equal(
                (await h.service.operation(h.userId, op.id)).status,
                'succeeded'
            )
            const [row] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, profile.id))
            assert.equal(row.lifecycle, 'ready')
            assert.equal(
                row.email,
                'inspected@vendor.local',
                'post-login inspect refreshed the identity'
            )
            assert.equal(row.credentialGeneration, 3)
        } finally {
            await h.close()
        }
    }
)

// The socket closes before the shell exits, so the daemon's journal still says
// running on the close-time read. Reconcile must wait for the verdict, and a
// row that nevertheless stayed open must heal on the next read.
test(
    'reconcile waits for the host verdict, and a stale running row heals on read',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const registry = (
                h.service as unknown as {
                    daemonRegistry: {
                        rpc: (a: {
                            method: string
                            payload: Record<string, unknown>
                        }) => Promise<unknown>
                    }
                }
            ).daemonRegistry
            const original = registry.rpc
            const journal = (status: string, resultCode: string | null) => ({
                profileId: 'x',
                kind: 'login',
                status,
                resultCode,
                error: resultCode ? 'sign-in shell exited 1' : null,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            })
            const profile = await h.service.create(h.principal, h.runtimeId, {
                authMethod: 'subscription'
            })

            // 1. The journal is still running for the first two reads.
            const op = await h.service.startLogin(
                h.principal,
                h.runtimeId,
                profile.id,
                {}
            )
            await h.service.loginTarget(h.userId, op.id)
            let reads = 0
            registry.rpc = async (args) => {
                if (args.method === 'auth.operation') {
                    reads += 1
                    return {
                        operationId: args.payload.operationId,
                        ...journal(
                            reads <= 2 ? 'running' : 'failed',
                            reads <= 2 ? null : 'login_incomplete'
                        )
                    }
                }
                return original(args)
            }
            await h.service.reconcileLogin(h.userId, op.id)
            assert.equal(
                reads,
                3,
                'reconcile re-read the journal until it settled'
            )
            const failed = await h.service.operation(h.userId, op.id)
            assert.equal(failed.status, 'failed')
            assert.equal(failed.resultCode, 'login_incomplete')

            // 2. A row left running (a reconcile that never ran) heals when
            //    it is read and the host has a verdict by then.
            const op2 = await h.service.startLogin(
                h.principal,
                h.runtimeId,
                profile.id,
                {}
            )
            await h.service.loginTarget(h.userId, op2.id)
            registry.rpc = async (args) => {
                if (args.method === 'auth.operation')
                    return {
                        operationId: args.payload.operationId,
                        ...journal('succeeded', null)
                    }
                return original(args)
            }
            const healed = await h.service.operation(h.userId, op2.id)
            assert.equal(healed.status, 'succeeded')
            const [row] = await h.db
                .select()
                .from(runtimeAuthProfiles)
                .where(eq(runtimeAuthProfiles.id, profile.id))
            assert.equal(
                row.lifecycle,
                'ready',
                'a healed success also readies the profile'
            )

            // 3. A read while the host still says running changes nothing and
            //    does not wait.
            const op3 = await h.service.startLogin(
                h.principal,
                h.runtimeId,
                profile.id,
                {}
            )
            await h.service.loginTarget(h.userId, op3.id)
            reads = 0
            registry.rpc = async (args) => {
                if (args.method === 'auth.operation') {
                    reads += 1
                    return {
                        operationId: args.payload.operationId,
                        ...journal('running', null)
                    }
                }
                return original(args)
            }
            const started = Date.now()
            assert.equal(
                (await h.service.operation(h.userId, op3.id)).status,
                'running'
            )
            assert.equal(reads, 1)
            assert.ok(
                Date.now() - started < 1000,
                'a read never waits on the host'
            )
        } finally {
            await h.close()
        }
    }
)
