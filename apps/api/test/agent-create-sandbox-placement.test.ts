import type { AgentCreateStep } from '@manyfold/shared'
import { PLATFORM_DEFAULT_SKILL_IDS } from '@manyfold/shared'
import type { NewAgent } from '@manyfold/db'
import assert from 'node:assert/strict'
import type { AgentRuntimeRow } from '@manyfold/db'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { RuntimeAgentAttachService } from '../src/modules/agents/orchestration/runtime-agent-attach.service'
import { SkillsService } from '../src/modules/skills/skills.service'
import {
    contextOf,
    fakeRuntimeContext,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

// A sandbox holds at most one instance per framework, so creating an agent for a
// framework the target sandbox already runs must join that instance rather than
// install a second copy. These tests pin the two things that makes that safe:
// no VM is provisioned (so no provisioned-quota slot is spent), and the runtime's
// own credentials are used instead of anything the request carried.

const runtimeOnHost = (overrides: Record<string, unknown> = {}) =>
    runtimeRow({
        id: 'art_existing',
        userId: 'user-1',
        name: 'sandbox-001-codex',
        framework: 'codex',
        hostId: 'sbx_1',
        mountPath: '/home/sprite',
        ...(overrides as Partial<AgentRuntimeRow>)
    })

const emptyDb = {
    select: () => ({
        from: () => ({
            where: () => ({
                limit: async () => [],
                orderBy: () => ({ limit: async () => [] })
            })
        })
    }),
    insert: () => ({
        values: (row: NewAgent) => ({
            returning: async () => [
                { ...row, createdAt: new Date(), updatedAt: new Date() }
            ]
        })
    }),
    update: () => ({ set: () => ({ where: async () => {} }) })
}

interface Harness {
    service: AgentOrchestratorService
    attachCalls: Array<Record<string, unknown>>
    provisionCalls: number
    credentialResolveCalls: number
    lookups: Array<{ hostId: string; framework: string; userId: string }>
    defaultInstalls: Array<Parameters<SkillsService['install']>[0]>
}

// `hostOwner` owns sbx_1. The fakes answer the way the real ones do: the
// provisioner only vouches for a sandbox of the caller's own, and a runtime
// lookup only finds the caller's own runtime.
const makeHarness = (
    instance: ReturnType<typeof runtimeOnHost> | null,
    {
        hostOwner = 'user-1',
        nameTakenBy
    }: { hostOwner?: string; nameTakenBy?: string } = {}
): Harness => {
    const state = {
        attachCalls: [] as Array<Record<string, unknown>>,
        provisionCalls: 0,
        credentialResolveCalls: 0,
        lookups: [] as Array<{
            hostId: string
            framework: string
            userId: string
        }>,
        defaultInstalls: [] as Array<Parameters<SkillsService['install']>[0]>
    }
    const skills = new SkillsService(
        {
            select: () => ({ from: () => ({ where: async () => [] }) })
        } as never,
        {} as never,
        {} as never,
        {
            getDefaultAgentSkills: async () => ({
                skillIds: PLATFORM_DEFAULT_SKILL_IDS
            })
        } as never
    )
    skills.install = async (input) => {
        state.defaultInstalls.push(input)
        return { materializeStatus: 'installed' } as never
    }
    const attach = new RuntimeAgentAttachService(
        emptyDb as never,
        {
            get: () => ({
                addAgent: async (input: {
                    agentId: string
                    workspace?: string
                }) => ({
                    internalId: input.agentId,
                    workspace: input.workspace,
                    model: null,
                    extras: {}
                })
            })
        } as never,
        { touchAfterWrite: () => {} } as never,
        { assertManagedChannelBindable: async () => {} } as never,
        skills,
        fakeRuntimeContext(
            contextOf({
                runtime: instance ?? runtimeOnHost(),
                host: spritesHostRow({ id: 'sbx_1', userId: hostOwner })
            })
        ) as never
    )
    const db = nameTakenBy
        ? {
              ...emptyDb,
              select: () => ({
                  from: () => ({
                      where: () => ({
                          limit: async () => [{ id: nameTakenBy }]
                      })
                  })
              })
          }
        : emptyDb
    const service = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {
            findRuntimeOnHost: async (
                hostId: string,
                framework: string,
                userId: string
            ) => {
                state.lookups.push({ hostId, framework, userId })
                return instance && instance.userId === userId ? instance : null
            }
        } as never,
        {
            assertSandboxAttachable: async (userId: string, hostId: string) => {
                if (userId !== hostOwner)
                    throw new NotFoundException({
                        message: `sandbox ${hostId} not available`,
                        code: 'SANDBOX_NOT_FOUND'
                    })
            },
            provisionRuntime: async () => {
                state.provisionCalls += 1
                throw new Error('provisionRuntime must not run')
            }
        } as never,
        {} as never,
        {} as never,
        {
            attach: async (args: Record<string, unknown>) => {
                state.attachCalls.push(args)
                return attach.attach(args as never)
            }
        } as never,
        {
            resolve: async () => {
                state.credentialResolveCalls += 1
                return {
                    framework: 'codex',
                    providerId: 'ump_1',
                    value: { openaiApiKey: 'sk-test' }
                } as never
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            getCachedFrameworkRuntimeDefaults: async () => ({ defaults: {} }),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} })
        } as never,
        {
            latestForFresh: async () => '1.2.3'
        } as never,
        {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        } as never,
        {
            get: () => ({ assignFor: async () => null })
        } as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never
    )
    return {
        service,
        get attachCalls() {
            return state.attachCalls
        },
        get provisionCalls() {
            return state.provisionCalls
        },
        get credentialResolveCalls() {
            return state.credentialResolveCalls
        },
        get lookups() {
            return state.lookups
        },
        get defaultInstalls() {
            return state.defaultInstalls
        }
    } as Harness
}

test('AgentOrchestrator create adds an agent to the framework instance already on the target sandbox', async () => {
    const instance = runtimeOnHost()
    const h = makeHarness(instance)
    const steps: AgentCreateStep[] = []

    const result = await h.service.create(
        {
            userId: 'user-1',
            actorUserId: 'user-1',
            isAdmin: false,
            dto: {
                name: 'Second Codex',
                framework: 'codex',
                runtime: 'sprites',
                sandboxId: 'sbx_1',
                workspace: '/repo/two',
                // The CLI is installed VM-wide, so a pinned version belongs to
                // the instance and is not re-pinned for the joining agent.
                frameworkVersion: '9.9.9'
            } as never
        },
        { step: (step) => steps.push(step) }
    )

    assert.match(result.id, /^agt_[a-z2-7]{26}$/)
    assert.deepEqual(h.defaultInstalls, [
        {
            userId: 'user-1',
            agentId: result.id,
            skillId: PLATFORM_DEFAULT_SKILL_IDS[0]
        }
    ])
    assert.deepEqual(h.lookups, [
        { hostId: 'sbx_1', framework: 'codex', userId: 'user-1' }
    ])
    assert.equal(h.attachCalls.length, 1)
    assert.equal(h.attachCalls[0].runtime, instance)
    assert.equal(h.attachCalls[0].name, 'Second Codex')
    assert.equal(h.attachCalls[0].workspace, '/repo/two')
    assert.equal(
        h.provisionCalls,
        0,
        'joining an existing instance must not provision a VM or spend a provisioned slot'
    )
    assert.equal(
        h.credentialResolveCalls,
        0,
        'the joining agent inherits the instance credentials; resolving the request payload would let it diverge'
    )
    assert.deepEqual(steps, ['validating', 'inserting_agent'])
})

test('AgentOrchestrator create refuses to join a framework instance that is not ready yet', async () => {
    const h = makeHarness(runtimeOnHost({ status: 'pending' }))

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: {
                    name: 'Too Early',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1'
                } as never
            }),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string; status?: string }).code ===
                'SANDBOX_FRAMEWORK_INSTANCE_NOT_READY' &&
            (err.getResponse() as { status?: string }).status === 'pending'
    )
    assert.equal(
        h.attachCalls.length,
        0,
        'attaching to a half-provisioned instance would create an agent the framework cannot serve'
    )
    assert.equal(h.provisionCalls, 0, 'and must not silently build a second VM')
})

test('AgentOrchestrator create provisions normally when the sandbox does not run the framework yet', async () => {
    const h = makeHarness(null)

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: {
                    name: 'First Codex',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1',
                    codexCredentials: { providerId: 'ump_1' }
                } as never
            }),
        // The harness makes provisionRuntime throw; reaching it IS the assertion
        // that no add-agent shortcut was taken.
        /provisionRuntime must not run/
    )
    assert.equal(h.attachCalls.length, 0)
    assert.equal(h.provisionCalls, 1)
    assert.equal(
        h.credentialResolveCalls,
        1,
        'a fresh instance owns its own credentials, so the request payload must be resolved'
    )
})

// Found in review [2026-09-29]: the join path looked the runtime up by host
// alone, and attach() compared that runtime with itself, so a caller holding
// another user's sandbox id created an agent in that user's account on their
// sandbox, on their credentials.
const isSandboxNotFound = (err: unknown): boolean =>
    err instanceof NotFoundException &&
    (err.getResponse() as { code?: string }).code === 'SANDBOX_NOT_FOUND'

test('AgentOrchestrator create does not join a sandbox that belongs to another user', async () => {
    const h = makeHarness(runtimeOnHost({ userId: 'user-2' }), {
        hostOwner: 'user-2'
    })

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: {
                    name: 'Intruder',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1'
                } as never
            }),
        isSandboxNotFound
    )
    assert.equal(h.attachCalls.length, 0)
    assert.equal(h.provisionCalls, 0)
})

test('AgentOrchestrator create on behalf of one user does not join another user\'s sandbox', async () => {
    const h = makeHarness(runtimeOnHost({ userId: 'user-2' }), {
        hostOwner: 'user-2'
    })

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'admin-1',
                isAdmin: true,
                dto: {
                    name: 'Cross Account',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1'
                } as never
            }),
        isSandboxNotFound
    )
    assert.equal(h.attachCalls.length, 0)
})

test('RuntimeAgentAttachService attach refuses a runtime its caller does not own', async () => {
    const foreign = runtimeOnHost({ userId: 'user-2' })
    const attach = new RuntimeAgentAttachService(
        emptyDb as never,
        { get: () => ({}) } as never,
        { touchAfterWrite: () => {} } as never,
        { assertManagedChannelBindable: async () => {} } as never,
        {} as never,
        fakeRuntimeContext(
            contextOf({
                runtime: foreign,
                host: spritesHostRow({ id: 'sbx_1', userId: 'user-2' })
            })
        ) as never
    )

    await assert.rejects(
        () =>
            attach.attach({
                runtime: foreign,
                name: 'Intruder',
                expectedOwnerUserId: 'user-1'
            } as never),
        (err) => err instanceof NotFoundException
    )
})

// Credentials live on the runtime (agent_credentials.runtime_id is unique), so
// honouring a joiner's would switch every agent on the instance, and dropping
// them silently left the caller believing the agent ran on what it sent.
test('AgentOrchestrator create refuses credentials for an agent joining an instance', async () => {
    const h = makeHarness(runtimeOnHost())

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: {
                    name: 'Second Codex',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1',
                    codexCredentials: { providerId: 'ump_other' }
                } as never
            }),
        (err) =>
            err instanceof BadRequestException &&
            (err.getResponse() as { code?: string }).code ===
                'JOIN_INHERITS_CREDENTIALS'
    )
    assert.equal(h.attachCalls.length, 0)
    assert.equal(h.credentialResolveCalls, 0)
})

test('AgentOrchestrator create names the agent that already has the name', async () => {
    const h = makeHarness(null, { nameTakenBy: 'agt_taken' })

    await assert.rejects(
        () =>
            h.service.create({
                userId: 'user-1',
                actorUserId: 'user-1',
                isAdmin: false,
                dto: {
                    name: 'Taken',
                    framework: 'codex',
                    runtime: 'sprites',
                    sandboxId: 'sbx_1'
                } as never
            }),
        (err) => {
            const body = (err as ConflictException).getResponse() as {
                code?: string
                details?: { agentId?: string }
            }
            return (
                err instanceof ConflictException &&
                body.code === 'AGENT_NAME_TAKEN' &&
                body.details?.agentId === 'agt_taken'
            )
        }
    )
})
