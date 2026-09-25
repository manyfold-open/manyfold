import test from 'node:test'
import assert from 'node:assert/strict'
import {
    BadRequestException,
    ConflictException,
    ForbiddenException
} from '@nestjs/common'
import { AgentOrchestratorService } from '../src/modules/agents/orchestration/agent-orchestrator.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'
import { assertPodHostFramework } from '../src/modules/agent-runtimes/provisioning/k8s-container-provisioner'

// #971: a k8s create without a purchased container. The port decides the
// edition's answer — cloud keeps CONTAINER_REQUIRED, the open default
// provisions a pod host on the fly so BYO k8s actually works on a
// self-hosted install (§6.3). These tests pin both answers and the gate
// order (master toggle before any provisioning).

const dto = {
    name: 'byo-k8s',
    framework: 'codex',
    runtime: 'k8s',
    clusterId: 'clus_1',
    codexCredentials: { openaiApiKey: 'sk-test' }
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
        framework: 'codex',
        hostId: 'pdh_fresh',
        status: 'ready'
    }
    const provisioner =
        opts.provisioner === false
            ? undefined
            : {
                  provision: async (input: Record<string, unknown>) => {
                      provisionCalls.push(input)
                      return {
                          runtime: freshRuntime,
                          completeAgentCreate: async () => {},
                          assertAgentCreateActive: async () => {},
                          runAgentCreate: async (
                              work: () => Promise<unknown>
                          ) => work(),
                          rollbackAgentCreate: async () => {}
                      }
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
                return {
                    id: input.agentCreateId ?? 'agt_new',
                    name: input.name
                }
            }
        } as never, // attach
        {
            resolve: async () => ({
                framework: 'codex',
                providerId: null,
                value: { resolved: 'codex-creds' }
            })
        } as never, // credentialsResolver
        {} as never, // backups
        {} as never, // adapterRegistry
        {} as never, // modelConfig
        {
            getCachedFrameworkRuntimeDefaults: async () => ({}),
            getCachedFrameworkDefaultVersions: async () => ({ defaults: {} }),
            isFeatureEnabled: async () => opts.toggleEnabled !== false
        } as never, // adminSettings
        { latestForFresh: async () => '1.2.3' } as never, // frameworkVersions
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

test('self-serve create provisions a pod host and attaches the agent to it', async () => {
    const h = makeService({ cloudComputer: openCloudComputerPort })
    const summary = (await h.service.create(ctx)) as { id: string }
    assert.equal(summary.id, h.attachCalls[0].agentCreateId)
    assert.equal(h.provisionCalls.length, 1)
    const input = h.provisionCalls[0]
    assert.deepEqual(
        input.sku,
        {
            id: null,
            region: null,
            cpuMillicores: 1000,
            memoryMb: 2048,
            diskGb: 10
        },
        'a self-serve host carries no SKU and no region — the open default attach-denial port treats every host as freely attachable'
    )
    assert.equal(input.framework, 'codex', 'the host is compute only; the framework is its first runtime')
    assert.deepEqual(
        input.frameworkVersion,
        { version: '1.2.3', source: 'latest' },
        'the install version is resolved before provisioning, as on a sprite'
    )
    assert.equal(
        input.clusterId,
        'clus_1',
        'BYO means the caller names the cluster; dropping it would land the container on whichever cluster has priority'
    )
    assert.deepEqual(
        input.credentials,
        { resolved: 'codex-creds' },
        'the provisioner must receive RESOLVED credentials (the runtime row stores them), not the raw dto shape'
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

test('a cloud computer runs the coding and service frameworks, nothing else', () => {
    for (const framework of ['codex', 'claude-code', 'openclaw', 'hermes'])
        assert.doesNotThrow(() => assertPodHostFramework(framework))
    assert.throws(
        () => assertPodHostFramework('dify'),
        (err: unknown) =>
            err instanceof BadRequestException &&
            (err.getResponse() as { code?: string }).code ===
                'FRAMEWORK_NOT_ON_POD_HOST'
    )
})

test('a service framework is provisioned onto a pod host', async () => {
    const h = makeService({ cloudComputer: openCloudComputerPort })
    await h.service.create({
        userId: 'usr_1',
        dto: { ...dto, framework: 'openclaw' },
        isAdmin: false
    } as never)
    assert.equal(
        h.provisionCalls.length,
        1,
        'the host daemon supervises its services (ADR-0035 P2)'
    )
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

// ---- the attach-denial seam carries the pod host identity (ADR-0035) ----

const ownedRuntime = {
    id: 'art_owned',
    userId: 'usr_1',
    kind: 'k8s',
    framework: 'codex',
    hostId: 'pdh_owned',
    status: 'ready'
}

const attachCtx = {
    userId: 'usr_1',
    dto: { ...dto, runtimeId: 'art_owned' },
    isAdmin: false
} as never

test('attach passes the pod host identity to the port and an async denial still denies', async () => {
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
        [{ podHostId: 'pdh_owned', isAdmin: false }],
        'a purchase buys a pod host, so the adapter resolves it by host id (ADR-0035)'
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
