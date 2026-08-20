import type { AgentCreateStep } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'

// A sandbox holds at most one instance per framework, so creating an agent for a
// framework the target sandbox already runs must join that instance rather than
// install a second copy. These tests pin the two things that makes that safe:
// no VM is provisioned (so no provisioned-quota slot is spent), and the runtime's
// own credentials are used instead of anything the request carried.

const runtimeOnHost = (overrides: Record<string, unknown> = {}) => ({
    id: 'art_existing',
    userId: 'user-1',
    name: 'sandbox-001-codex',
    framework: 'codex',
    kind: 'sprites',
    status: 'ready',
    hostId: 'sbx_1',
    spriteName: 'sbx-1',
    spriteId: 'sprite-1',
    accountId: 'spa_1',
    mountPath: '/home/sprite',
    primaryAgentId: 'agt_first',
    ...overrides
})

const emptyDb = {
    select: () => ({
        from: () => ({
            where: () => ({ limit: async () => [] })
        })
    })
}

interface Harness {
    service: AgentOrchestratorService
    attachCalls: Array<Record<string, unknown>>
    provisionCalls: number
    credentialResolveCalls: number
    lookups: Array<{ hostId: string; framework: string }>
}

const makeHarness = (instance: Record<string, unknown> | null): Harness => {
    const state = {
        attachCalls: [] as Array<Record<string, unknown>>,
        provisionCalls: 0,
        credentialResolveCalls: 0,
        lookups: [] as Array<{ hostId: string; framework: string }>
    }
    const service = new AgentOrchestratorService(
        emptyDb as never,
        {} as never,
        {} as never,
        {} as never,
        {
            findSpriteRuntimeOnHost: async (
                hostId: string,
                framework: string
            ) => {
                state.lookups.push({ hostId, framework })
                return instance
            }
        } as never,
        {
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
                return { id: 'agt_new', name: args.name } as never
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
                // Runtime-scoped inputs a caller may still send. Credentials live
                // on the runtime (agent_credentials.runtime_id is unique) and the
                // CLI is installed VM-wide, so both belong to the instance and
                // must not be re-resolved or re-pinned for the joining agent.
                codexCredentials: { providerId: 'ump_other' },
                frameworkVersion: '9.9.9'
            } as never
        },
        { step: (step) => steps.push(step) }
    )

    assert.equal(result.id, 'agt_new')
    assert.deepEqual(h.lookups, [{ hostId: 'sbx_1', framework: 'codex' }])
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
