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
    runtimeAuthProfiles,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { RUNTIME_AUTH_ERROR } from '@manyfold/shared'
import type { AuthPrincipal } from '@/common/guards/auth.guard'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'

// The binding CAS is a WHERE predicate (id AND binding version), which the
// fake db cannot prove; this runs it against a real database. The service's
// provider/catalog collaborators are unused by the binding path, so they are
// empty fakes and buildView is stubbed to hand the row back.

const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    service: AgentModelConfigService
    principal: AuthPrincipal
    userId: string
    runtimeId: string
    agentId: string
    profile: (over?: Record<string, unknown>) => Promise<string>
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const userId = `user_rab_${suffix}`
    const planId = `plan_rab_${suffix}`
    const hostId = `dh_rab${suffix}`
    const runtimeId = `art_rab${suffix}`
    const agentId = `agt_rab${suffix}`
    await db.insert(plans).values({
        id: planId,
        name: `rab ${suffix}`,
        maxAgentsProvisioned: 5,
        maxConcurrentActive: 5,
        maxStorageGb: 100,
        monthlyApiRequestLimit: null
    })
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@rab.local`, planId })
    await db.insert(runtimeHosts).values({
        id: hostId,
        userId,
        kind: 'daemon',
        name: `rab-host-${suffix}`,
        status: 'active',
        clientFeatures: ['auth-profiles.v1', 'auth-context.v1'],
        rpcLastSeenAt: new Date()
    } as never)
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `rab-runtime-${suffix}`,
        framework: 'codex',
        kind: 'daemon',
        status: 'ready',
        daemonId: hostId,
        hostId
    } as never)
    await db.insert(agents).values({
        id: agentId,
        userId,
        name: 'bound',
        framework: 'codex',
        runtime: 'daemon',
        runtimeId,
        daemonId: hostId,
        internalId: agentId,
        extras: { runtimeLocalModelConfig: { available: true, ready: true } }
    } as never)
    const service = new AgentModelConfigService(
        db,
        {} as never,
        {} as never,
        {} as never
    )
    ;(
        service as unknown as {
            buildView: (agent: unknown) => Promise<unknown>
        }
    ).buildView = async (agent) => agent
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
        agentId,
        profile: async (over = {}) => {
            const id = `rap_${randomBytes(13)
                .toString('hex')
                .slice(0, 26)
                .replace(/[^a-z2-7]/g, 'a')}`
            await db.insert(runtimeAuthProfiles).values({
                id,
                userId,
                runtimeId,
                framework: 'codex',
                label: 'p',
                authMethod: 'subscription',
                lifecycle: 'ready',
                ...over
            } as never)
            return id
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

const code = (err: unknown): string | undefined =>
    (err as { response?: { code?: string } }).response?.code

test(
    'binding is compare-and-set, scoped to the agent runtime, and clears the inspect cache',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const a = await h.profile()
            const bound = (await h.service.updateRuntimeAuth(
                h.principal,
                h.agentId,
                {
                    profileId: a,
                    expectedBindingVersion: 0
                }
            )) as unknown as {
                runtimeAuthProfileId: string
                runtimeAuthBindingVersion: number
                extras: Record<string, unknown>
            }
            assert.equal(bound.runtimeAuthProfileId, a)
            assert.equal(bound.runtimeAuthBindingVersion, 1)
            assert.equal(
                'runtimeLocalModelConfig' in bound.extras,
                false,
                'the cached capability was inspected under the old context'
            )

            // A stale version (another tab) is refused and changes nothing.
            await assert.rejects(
                h.service.updateRuntimeAuth(h.principal, h.agentId, {
                    profileId: null,
                    expectedBindingVersion: 0
                }),
                (err: unknown) =>
                    code(err) === RUNTIME_AUTH_ERROR.bindingConflict
            )
            const [row] = await h.db
                .select()
                .from(agents)
                .where(eq(agents.id, h.agentId))
            assert.equal(row.runtimeAuthProfileId, a)
            assert.equal(row.runtimeAuthBindingVersion, 1)

            // Another runtime's profile, a deleted one, and a deleting one are refused.
            const otherRuntime = `art_rab${randomBytes(6).toString('hex')}`
            await h.db.insert(agentRuntimes).values({
                id: otherRuntime,
                userId: h.userId,
                name: 'other',
                framework: 'codex',
                kind: 'daemon',
                status: 'ready'
            } as never)
            const foreign = await h.profile({ runtimeId: otherRuntime })
            await assert.rejects(
                h.service.updateRuntimeAuth(h.principal, h.agentId, {
                    profileId: foreign,
                    expectedBindingVersion: 1
                }),
                (err: unknown) => code(err) === RUNTIME_AUTH_ERROR.notFound
            )
            const deleting = await h.profile({ lifecycle: 'deleting' })
            await assert.rejects(
                h.service.updateRuntimeAuth(h.principal, h.agentId, {
                    profileId: deleting,
                    expectedBindingVersion: 1
                }),
                (err: unknown) => code(err) === RUNTIME_AUTH_ERROR.stateConflict
            )

            // Unbind back to ambient with the current version.
            const cleared = (await h.service.updateRuntimeAuth(
                h.principal,
                h.agentId,
                {
                    profileId: null,
                    expectedBindingVersion: 1
                }
            )) as unknown as {
                runtimeAuthProfileId: string | null
                runtimeAuthBindingVersion: number
            }
            assert.equal(cleared.runtimeAuthProfileId, null)
            assert.equal(cleared.runtimeAuthBindingVersion, 2)

            // The profile can now be deleted; bound it could not (RESTRICT).
            await h.service.updateRuntimeAuth(h.principal, h.agentId, {
                profileId: a,
                expectedBindingVersion: 2
            })
            await assert.rejects(
                h.db
                    .delete(runtimeAuthProfiles)
                    .where(eq(runtimeAuthProfiles.id, a)),
                /violates foreign key/
            )
        } finally {
            await h.close()
        }
    }
)

test(
    'a platform agent cannot take a profile without switching source in the same request; agents cannot bind at all',
    { skip: !RUN },
    async () => {
        const h = await buildHarness()
        try {
            const a = await h.profile()
            await h.db
                .update(agents)
                .set({ extras: { modelConfig: { source: 'platform' } } })
                .where(eq(agents.id, h.agentId))
            await assert.rejects(
                h.service.updateRuntimeAuth(h.principal, h.agentId, {
                    profileId: a,
                    expectedBindingVersion: 0
                }),
                (err: unknown) =>
                    code(err) === RUNTIME_AUTH_ERROR.targetMismatch
            )
            const switched = (await h.service.updateRuntimeAuth(
                h.principal,
                h.agentId,
                {
                    profileId: a,
                    expectedBindingVersion: 0,
                    modelConfigSource: 'runtime-local'
                }
            )) as unknown as {
                extras: { modelConfig: { source: string } }
                runtimeAuthProfileId: string
            }
            assert.equal(switched.extras.modelConfig.source, 'runtime-local')
            assert.equal(switched.runtimeAuthProfileId, a)
            const agentPrincipal = {
                userId: h.userId,
                kind: 'agent-runtime'
            } as unknown as AuthPrincipal
            await assert.rejects(
                h.service.updateRuntimeAuth(agentPrincipal, h.agentId, {
                    profileId: null,
                    expectedBindingVersion: 1
                }),
                (err: { status?: number }) => err.status === 403
            )
        } finally {
            await h.close()
        }
    }
)
