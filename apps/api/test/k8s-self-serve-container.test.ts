import test from 'node:test'
import assert from 'node:assert/strict'
import { ConflictException, ForbiddenException } from '@nestjs/common'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'

// #971: a k8s create without a purchased container. The port decides the
// edition's answer — cloud keeps CONTAINER_REQUIRED, the open default
// provisions a container on the fly so BYO k8s actually works on a
// self-hosted install (§6.3). These tests pin both answers and the gate
// order (master toggle before any provisioning).

const dto = {
    name: 'byo-k8s',
    framework: 'openclaw',
    runtime: 'k8s',
    clusterId: 'clus_1',
    openclawCredentials: {
        modelProvider: 'openai',
        apiKey: 'sk-test',
        primaryModelName: 'gpt-test'
    }
}

interface Harness {
    service: AgentOrchestratorService
    provisionCalls: Array<Record<string, unknown>>
    attachCalls: Array<Record<string, unknown>>
}

const makeService = (opts: {
    cloudComputer?: unknown
    provisioner?: false
    toggleEnabled?: boolean
    runtime?: Record<string, unknown>
}): Harness => {
    const provisionCalls: Array<Record<string, unknown>> = []
    const attachCalls: Array<Record<string, unknown>> = []
    const freshRuntime = {
        id: 'art_fresh',
        kind: 'k8s',
        framework: 'openclaw',
        status: 'ready'
    }
    const provisioner =
        opts.provisioner === false
            ? undefined
            : {
                  provision: async (input: Record<string, unknown>) => {
                      provisionCalls.push(input)
                      return { runtime: freshRuntime }
                  }
              }
    const service = new AgentOrchestratorService(
        {} as never, // db
        {} as never, // agentsService
        {} as never, // accounts
        {} as never, // crypto
        { findById: async () => opts.runtime ?? null } as never, // runtimes
        {} as never, // spritesProvisioner
        {} as never, // externalProvisioner
        {} as never, // k8sOrchestrator
        {
            attach: async (input: Record<string, unknown>) => {
                attachCalls.push(input)
                return { id: 'agt_new', name: input.name }
            }
        } as never, // attach
        {
            resolve: async () => ({
                framework: 'openclaw',
                providerId: null,
                value: { resolved: 'openclaw-creds' }
            })
        } as never, // credentialsResolver
        {} as never, // backups
        {} as never, // adapterRegistry
        {} as never, // modelConfig
        {
            getCachedFrameworkRuntimeDefaults: async () => ({}),
            isFeatureEnabled: async () => opts.toggleEnabled !== false
        } as never, // adminSettings
        {} as never, // frameworkVersions
        { getFrameworkRuntimeOverrides: async () => ({}) } as never, // users
        {} as never, // moduleRef
        { recordFirstAgentCreated: async () => undefined } as never, // attribution
        { event: () => {} } as never, // telemetry
        undefined as never, // runtimeTokens
        undefined as never, // experimentAssignments
        opts.cloudComputer as never,
        provisioner as never
    )
    return { service, provisionCalls, attachCalls }
}

const ctx = { userId: 'usr_1', dto, isAdmin: false } as never

test('open default port pins a concrete self-serve envelope', () => {
    assert.deepEqual(
        openCloudComputerPort.selfServeContainerSpec(),
        { cpuMillicores: 1000, memoryMb: 2048, diskGb: 10 },
        'the self-hosted container envelope is a contract: silently shrinking it would OOM existing framework pods, silently growing it would overcommit small clusters'
    )
})

test('cloud port (null spec) keeps CONTAINER_REQUIRED for k8s creates without runtimeId', async () => {
    const h = makeService({
        cloudComputer: {
            ...openCloudComputerPort,
            selfServeContainerSpec: () => null
        }
    })
    await assert.rejects(
        h.service.create(ctx),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'CONTAINER_REQUIRED',
        'when the edition sells containers, a create without a purchase must keep answering 409 — provisioning here would mint unbilled capacity'
    )
    assert.equal(h.provisionCalls.length, 0)
})

test('missing provisioner degrades to CONTAINER_REQUIRED instead of a 500', async () => {
    const h = makeService({
        cloudComputer: openCloudComputerPort,
        provisioner: false
    })
    await assert.rejects(
        h.service.create(ctx),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'CONTAINER_REQUIRED'
    )
})

test('self-serve create provisions a container and attaches the agent to it', async () => {
    const h = makeService({ cloudComputer: openCloudComputerPort })
    const summary = (await h.service.create(ctx)) as { id: string }
    assert.equal(summary.id, 'agt_new')
    assert.equal(h.provisionCalls.length, 1)
    const input = h.provisionCalls[0]
    assert.deepEqual(
        input.sku,
        {
            id: null,
            framework: 'openclaw',
            region: null,
            cpuMillicores: 1000,
            memoryMb: 2048,
            diskGb: 10
        },
        'a self-serve container carries no SKU and no region — the open default attach-denial port treats every runtime as freely attachable'
    )
    assert.equal(
        input.clusterId,
        'clus_1',
        'BYO means the caller names the cluster; dropping it would land the container on whichever cluster has priority'
    )
    assert.deepEqual(
        input.credentials,
        { resolved: 'openclaw-creds' },
        'the provisioner must receive RESOLVED credentials (the bootstrap env secret is built from them), not the raw dto shape'
    )
    assert.equal(h.attachCalls.length, 1)
    assert.equal(
        (h.attachCalls[0].runtime as { id: string }).id,
        'art_fresh',
        'the agent must attach to the container that was just provisioned'
    )
})

test('port absence falls back to the open default and provisions', async () => {
    const h = makeService({ cloudComputer: undefined })
    await h.service.create(ctx)
    assert.equal(h.provisionCalls.length, 1)
})

test('the cloud_computer master toggle blocks self-serve provisioning', async () => {
    const h = makeService({
        cloudComputer: openCloudComputerPort,
        toggleEnabled: false
    })
    await assert.rejects(
        h.service.create(ctx),
        (err: unknown) =>
            err instanceof ForbiddenException &&
            (err.getResponse() as { code?: string }).code ===
                'CLOUD_COMPUTER_DISABLED',
        'the master switch must gate NEW provisioning exactly like reserveRuntime gates purchased containers — self-serve must not become a toggle bypass'
    )
    assert.equal(h.provisionCalls.length, 0)
})

// ---- Phase-4 (§4.1): the attach-denial seam carries the runtime identity ----

const ownedRuntime = {
    id: 'art_owned',
    userId: 'usr_1',
    kind: 'k8s',
    framework: 'openclaw',
    status: 'ready'
}

const attachCtx = {
    userId: 'usr_1',
    dto: { ...dto, runtimeId: 'art_owned' },
    isAdmin: false
} as never

test('attach passes the runtime identity to the port and an async denial still denies', async () => {
    const seen: Array<Record<string, unknown>> = []
    const h = makeService({
        runtime: ownedRuntime,
        cloudComputer: {
            ...openCloudComputerPort,
            agentAttachDenial: async (args: Record<string, unknown>) => {
                seen.push(args)
                return { code: 'RUNTIME_READ_ONLY', message: 'read only' }
            }
        }
    })
    await assert.rejects(
        h.service.create(attachCtx),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'RUNTIME_READ_ONLY',
        'a promise-returning adapter must deny with ITS code — losing the await would throw a code-less bogus denial for every async adapter'
    )
    assert.deepEqual(
        seen,
        [{ runtimeId: 'art_owned', isAdmin: false }],
        'the adapter resolves the purchase from its own subscription rows by runtime id (design §9 Phase-4)'
    )
})

test('an async null denial attaches — the promise itself must not be truthy-checked', async () => {
    const h = makeService({
        runtime: ownedRuntime,
        cloudComputer: {
            ...openCloudComputerPort,
            agentAttachDenial: async () => null
        }
    })
    await h.service.create(attachCtx)
    assert.equal(h.attachCalls.length, 1)
    assert.equal(h.provisionCalls.length, 0)
})
