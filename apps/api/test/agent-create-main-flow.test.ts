import {
    AgentCreateStep,
    auditAction
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    auditLogs,
    type NewAgent
} from '@manyfold/db'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { MANYFOLD_CONTEXT_VERSION } from '../src/modules/agent-self/agent-context-doc.service'

const now = new Date('2026-05-22T10:00:00.000Z')

test('AgentOrchestrator create runs the sprites coding-agent happy path', async () => {
    const db = new FakeCreateAgentDb()
    const steps: AgentCreateStep[] = []
    let provisionArgs: Record<string, unknown> | null = null
    let finalizedRuntimeId: string | null = null
    let persistedInline = false
    const modelConfigCalls: Array<{
        method: string
        userId: string
        agentId: string
        source?: unknown
    }> = []
    const provisionedRuntime = runtimeRow()

    const service = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {
            encrypt: (plain: string) => ({
                ciphertext: `enc:${plain}`,
                keyVersion: 7
            })
        } as never,
        {} as never,
        {
            provisionRuntime: async (args: Record<string, unknown>) => {
                provisionArgs = args
                const emitter = args.emitter as {
                    step(step: AgentCreateStep): void
                }
                emitter.step('selecting_account')
                emitter.step('checking_quota')
                emitter.step('creating_sprite')
                emitter.step('bootstrapping')
                db.runtimeRows.push(provisionedRuntime)
                return {
                    runtime: provisionedRuntime,
                    account: { id: 'spa_1', slug: 'default' },
                    spritesClient: {},
                    homeDir: '/home/sprite'
                }
            },
            installRuntimeIdentity: async () => {},
            finalizeReady: async (runtimeId: string) => {
                finalizedRuntimeId = runtimeId
            },
            teardownRuntime: async () => {
                throw new Error('teardown should not run')
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            resolve: async () => ({
                framework: 'claude-code',
                providerId: 'ump_1',
                value: {
                    anthropicAuthToken: 'sk-ant-test',
                    anthropicBaseUrl: 'https://anthropic.example.test'
                }
            }),
            maybePersistInline: async () => {
                persistedInline = true
            }
        } as never,
        {
            restoreBackupToAgentForCreate: async () => {
                throw new Error('restore should not run')
            }
        } as never,
        {} as never,
        {
            ensureProviderModelsReady: async (
                userId: string,
                agentId: string,
                _isAdmin: boolean,
                source?: unknown
            ) => {
                modelConfigCalls.push({
                    method: 'ensure',
                    userId,
                    agentId,
                    source
                })
            },
            updateForAgent: async (
                userId: string,
                agentId: string,
                body: { modelConfigSource?: unknown }
            ) => {
                modelConfigCalls.push({
                    method: 'update',
                    userId,
                    agentId,
                    source: body.modelConfigSource
                })
            }
        } as never,
        {
            getCachedFrameworkRuntimeDefaults: async () => ({
                defaults: { hermes: 'sprites', openclaw: 'sprites' }
            }),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} }),
            getDefaultAgentSkills: async () => ({ skillIds: [] })
        } as never,
        {
            latestForFresh: async () => '2.9.9'
        } as never,
        {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        } as never,
        {
            get: () => ({
                assignFor: async () => null
            })
        } as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never
    )

    const result = await service.create(
        {
            userId: 'user-1',
            actorUserId: 'user-1',
            isAdmin: false,
            dto: {
                name: '  Core Agent  ',
                framework: 'claude-code',
                runtime: 'sprites',
                workspace: '/repo/project',
                claudeCodeCredentials: { providerId: 'ump_1' },
                modelConfigSource: 'platform'
            } as never
        },
        { step: (step) => steps.push(step) }
    )

    assert.equal(result.name, 'Core Agent')
    assert.equal(result.runtime, 'sprites')
    assert.equal(result.status, 'running')
    assert.equal(result.spriteStatus, 'running')
    assert.equal(result.accountSlug, 'default')
    assert.equal(result.workspacePath, '/repo/project')
    assert.match(result.id, /^agt_[a-z2-7]{26}$/)

    const capturedProvisionArgs = provisionArgs as Record<
        string,
        unknown
    > | null
    assert.equal(capturedProvisionArgs?.userId, 'user-1')
    assert.equal(capturedProvisionArgs?.agentId, result.id)
    assert.equal(capturedProvisionArgs?.workspacePath, '/repo/project')
    assert.equal(capturedProvisionArgs?.workspaceManaged, false)
    // Unpinned create must install the newest upstream release, not whatever the
    // sprite image happens to ship — and must say the target was implicit so a
    // failed install degrades instead of failing the create.
    assert.equal(capturedProvisionArgs?.frameworkVersion, '2.9.9')
    assert.equal(capturedProvisionArgs?.frameworkVersionSource, 'latest')

    assert.equal(db.agentRows.length, 1)
    const agent = db.agentRows[0]
    assert.equal(agent.id, result.id)
    assert.equal(agent.runtimeId, provisionedRuntime.id)
    assert.equal(agent.accountId, 'spa_1')
    assert.equal(agent.modelProviderId, 'ump_1')
    const extras = agent.extras as {
        workspaceManaged: boolean
        contextDoc?: { version: number; generatedAt: string }
    }
    assert.equal(extras.workspaceManaged, false)
    assert.equal(extras.contextDoc?.version, MANYFOLD_CONTEXT_VERSION)
    assert.match(
        extras.contextDoc?.generatedAt ?? '',
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/
    )
    assert.deepEqual(
        (agent.fileRoots ?? []).map((root) => root.id),
        ['workspace', 'claude-home', 'home']
    )

    assert.equal(db.credentialRows.length, 1)
    assert.equal(db.credentialRows[0].runtimeId, provisionedRuntime.id)
    assert.equal(db.credentialRows[0].framework, 'claude-code')
    assert.equal(db.credentialRows[0].keyVersion, 7)
    assert.match(String(db.credentialRows[0].payloadCiphertext), /sk-ant-test/)

    assert.equal(provisionedRuntime.primaryAgentId, result.id)
    assert.equal(finalizedRuntimeId, provisionedRuntime.id)
    assert.equal(persistedInline, true)
    assert.deepEqual(modelConfigCalls, [
        {
            method: 'ensure',
            userId: 'user-1',
            agentId: result.id,
            source: 'platform'
        },
        {
            method: 'update',
            userId: 'user-1',
            agentId: result.id,
            source: 'platform'
        }
    ])
    assert.deepEqual(steps, [
        'validating',
        'selecting_account',
        'checking_quota',
        'creating_sprite',
        'bootstrapping',
        'inserting_agent',
        'storing_credentials',
        'finalizing'
    ])
    assert.deepEqual(
        db.auditRows.map((row) => row.action),
        [auditAction.AGENT_CREATE_STARTED, auditAction.AGENT_CREATE_SUCCEEDED]
    )
})

test('AgentOrchestrator creates a credential-less runtime-local sprites agent', async () => {
    const db = new FakeCreateAgentDb()
    const steps: AgentCreateStep[] = []
    let provisionArgs: Record<string, unknown> | null = null
    const terminalCalls: Array<Record<string, unknown>> = []
    const modelConfigCalls: Array<{
        method: string
        agentId: string
        source?: unknown
    }> = []
    const provisionedRuntime = { ...runtimeRow(), hostId: 'rth_1' }

    const service = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {
            encrypt: (plain: string) => ({
                ciphertext: `enc:${plain}`,
                keyVersion: 7
            })
        } as never,
        {
            setSandboxTerminalEnabled: async (
                userId: string,
                hostId: string,
                enabled: boolean
            ) => {
                terminalCalls.push({ userId, hostId, enabled })
                return true
            }
        } as never,
        {
            provisionRuntime: async (args: Record<string, unknown>) => {
                provisionArgs = args
                const emitter = args.emitter as {
                    step(step: AgentCreateStep): void
                }
                emitter.step('selecting_account')
                emitter.step('checking_quota')
                emitter.step('creating_sprite')
                emitter.step('bootstrapping')
                db.runtimeRows.push(provisionedRuntime)
                return {
                    runtime: provisionedRuntime,
                    account: { id: 'spa_1', slug: 'default' },
                    spritesClient: {},
                    homeDir: '/home/sprite'
                }
            },
            installRuntimeIdentity: async () => {},
            finalizeReady: async () => {},
            teardownRuntime: async () => {
                throw new Error('teardown should not run')
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {
            // Mirrors CredentialsResolverService's runtime-local short-circuit:
            // no credential block arrives, so the stored payload is empty.
            resolve: async () => ({
                framework: 'claude-code',
                providerId: null,
                value: {}
            }),
            maybePersistInline: async () => {}
        } as never,
        {
            restoreBackupToAgentForCreate: async () => {
                throw new Error('restore should not run')
            }
        } as never,
        {} as never,
        {
            ensureProviderModelsReady: async (
                _userId: string,
                agentId: string,
                _isAdmin: boolean,
                source?: unknown
            ) => {
                modelConfigCalls.push({ method: 'ensure', agentId, source })
            },
            updateForAgent: async (
                _userId: string,
                agentId: string,
                body: { modelConfigSource?: unknown }
            ) => {
                modelConfigCalls.push({
                    method: 'update',
                    agentId,
                    source: body.modelConfigSource
                })
            }
        } as never,
        {
            getCachedFrameworkRuntimeDefaults: async () => ({
                defaults: { hermes: 'sprites', openclaw: 'sprites' }
            }),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} }),
            getDefaultAgentSkills: async () => ({ skillIds: [] })
        } as never,
        {
            latestForFresh: async () => '2.9.9'
        } as never,
        {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        } as never,
        {
            get: () => ({
                assignFor: async () => null
            })
        } as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never
    )

    const result = await service.create(
        {
            userId: 'user-1',
            actorUserId: 'user-1',
            isAdmin: false,
            dto: {
                name: 'Subscription Agent',
                framework: 'claude-code',
                runtime: 'sprites',
                workspace: '/repo/project',
                modelConfigSource: 'runtime-local'
            } as never
        },
        { step: (step) => steps.push(step) }
    )

    assert.equal(result.status, 'running')
    const capturedProvisionArgs = provisionArgs as Record<
        string,
        unknown
    > | null
    assert.equal(capturedProvisionArgs?.modelConfigSource, 'runtime-local')

    assert.equal(db.agentRows.length, 1)
    assert.equal(db.agentRows[0].modelProviderId, null)

    // The row exists (decryptCreds and the report-token merge need one) but
    // carries no platform key.
    assert.equal(db.credentialRows.length, 1)
    assert.equal(db.credentialRows[0].payloadCiphertext, 'enc:{}')

    assert.deepEqual(modelConfigCalls, [
        { method: 'ensure', agentId: result.id, source: 'runtime-local' },
        { method: 'update', agentId: result.id, source: 'runtime-local' }
    ])
    assert.deepEqual(terminalCalls, [
        { userId: 'user-1', hostId: 'rth_1', enabled: true }
    ])
    assert.deepEqual(steps, [
        'validating',
        'selecting_account',
        'checking_quota',
        'creating_sprite',
        'bootstrapping',
        'inserting_agent',
        'storing_credentials',
        'finalizing'
    ])
})

test('AgentOrchestrator create runs A2A through external provisioning', async () => {
    const db = new FakeCreateAgentDb()
    const steps: AgentCreateStep[] = []
    let provisionArgs: Record<string, unknown> | null = null
    const runtime = {
        ...runtimeRow(),
        id: 'art_external_1',
        framework: 'a2a',
        kind: 'external',
        status: 'ready',
        accountId: null,
        spriteName: null,
        spriteId: null,
        mountPath: '/workspace'
    }

    const service = new AgentOrchestratorService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            provisionRuntime: async (args: Record<string, unknown>) => {
                provisionArgs = args
                db.runtimeRows.push(runtime)
                return { runtime }
            },
            teardownRuntime: async () => {
                throw new Error('teardown should not run')
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            getCachedFrameworkRuntimeDefaults: async () => ({ defaults: {} }),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} })
        } as never,
        {
            latestForFresh: async () => null
        } as never,
        {
            getFrameworkRuntimeOverrides: async () => ({ overrides: {} })
        } as never,
        {
            get: () => ({
                assignFor: async () => null
            })
        } as never,
        { recordFirstAgentCreated: async () => {} } as never,
        {} as never
    )

    const result = await service.create(
        {
            userId: 'user-1',
            actorUserId: 'user-1',
            isAdmin: false,
            dto: {
                name: 'A2A Agent',
                framework: 'a2a',
                runtime: 'external',
                a2aBinding: {
                    providerId: 'provider-1',
                    selectedSkillId: 'skill-1'
                }
            } as never
        },
        { step: (step) => steps.push(step) }
    )

    assert.equal(result.framework, 'a2a')
    assert.equal(result.runtime, 'external')
    assert.equal(result.status, 'running')
    const capturedProvisionArgs = provisionArgs as Record<
        string,
        unknown
    > | null
    assert.equal(capturedProvisionArgs?.framework, 'a2a')
    assert.deepEqual(capturedProvisionArgs?.binding, {
        providerId: 'provider-1',
        remoteRef: { selectedSkillId: 'skill-1' }
    })
    assert.equal(db.agentRows.length, 1)
    assert.deepEqual(db.agentRows[0].extras, {
        externalBinding: {
            providerId: 'provider-1',
            framework: 'a2a',
            remoteRef: { selectedSkillId: 'skill-1' }
        }
    })
    assert.equal(db.runtimeRows[0].primaryAgentId, result.id)
    assert.deepEqual(steps, ['validating', 'inserting_agent'])
})

const runtimeRow = () => ({
    id: 'art_1',
    userId: 'user-1',
    name: 'Core Agent',
    framework: 'claude-code',
    kind: 'sprites',
    status: 'pending',
    accountId: 'spa_1',
    spriteName: 'agt-core-agent',
    spriteId: 'sprite-1',
    primaryAgentId: null as string | null,
    mountPath: '/repo/project',
    namespace: null,
    ingressHost: null,
    clusterId: null,
    daemonId: null,
    spriteUrl: null,
    homeDir: '/home/sprite',
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null,
    lastReconciledAt: null,
    createdAt: now,
    updatedAt: now
})

class FakeCreateAgentDb {
    agentRows: Array<NewAgent & Record<string, unknown>> = []
    runtimeRows: Array<Record<string, unknown>> = []
    credentialRows: Array<Record<string, unknown>> = []
    auditRows: Array<Record<string, unknown>> = []

    select(): FakeQuery {
        return new FakeQuery(this, 'select')
    }

    insert(table: unknown): FakeQuery {
        return new FakeQuery(this, 'insert', table)
    }

    update(table: unknown): FakeQuery {
        return new FakeQuery(this, 'update', table)
    }

    rowsFor(table: unknown): Record<string, unknown>[] {
        if (table === agents) return this.agentRows
        if (table === agentRuntimes) return this.runtimeRows
        return []
    }

    insertRow(
        table: unknown,
        values: Record<string, unknown>
    ): Record<string, unknown>[] {
        if (table === agents) {
            const row = {
                ...values,
                spriteStatus: null,
                k8sPodPhase: null,
                storageBytes: null,
                storageMeasuredAt: null,
                createdAt: now,
                updatedAt: now
            }
            this.agentRows.push(row as NewAgent & Record<string, unknown>)
            return [row]
        }
        if (table === agentCredentials) {
            this.credentialRows.push(values)
            return [values]
        }
        if (table === auditLogs) {
            this.auditRows.push(values)
            return [values]
        }
        return []
    }

    updateRows(
        table: unknown,
        patch: Record<string, unknown>
    ): Record<string, unknown>[] {
        if (table === agentRuntimes) {
            Object.assign(this.runtimeRows[0], patch)
            return this.runtimeRows.slice(0, 1)
        }
        if (table === agents) {
            Object.assign(this.agentRows[0], patch)
            return this.agentRows.slice(0, 1)
        }
        return []
    }
}

class FakeQuery implements PromiseLike<unknown[]> {
    private table?: unknown
    private valuesOrPatch: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeCreateAgentDb,
        private readonly kind: 'select' | 'insert' | 'update',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown): this {
        this.table = table
        return this
    }

    where(): this {
        return this
    }

    limit(n: number): Promise<unknown[]> {
        return Promise.resolve(this.resolveRows().slice(0, n))
    }

    values(values: Record<string, unknown>): this {
        this.valuesOrPatch = values
        return this
    }

    set(patch: Record<string, unknown>): this {
        this.valuesOrPatch = patch
        return this
    }

    returning(): Promise<unknown[]> {
        return Promise.resolve(this.resolveRows())
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): PromiseLike<TResult1 | TResult2> {
        return Promise.resolve(this.resolveRows()).then(onfulfilled, onrejected)
    }

    private resolveRows(): unknown[] {
        if (this.kind === 'select') return this.db.rowsFor(this.table)
        if (this.kind === 'insert')
            return this.db.insertRow(this.table, this.valuesOrPatch)
        if (this.kind === 'update')
            return this.db.updateRows(this.table, this.valuesOrPatch)
        return []
    }
}
