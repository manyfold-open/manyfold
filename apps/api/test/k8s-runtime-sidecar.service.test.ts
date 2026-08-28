import assert from 'node:assert/strict'
import test from 'node:test'
import { InternalServerErrorException } from '@nestjs/common'
import { K8sRuntimeSidecarService } from '../src/modules/agent-runtimes/orchestration/k8s-runtime-sidecar.service'
import { hermesDashboardSidecar } from '../src/modules/agents/bootstrap/hermes'
import {
    buildSidecarIngress,
    resourceName,
    type K8sResourceSpec
} from '../src/modules/agents/orchestration/k8s-resource-builder'

const runtime = (patch: Record<string, unknown> = {}) => ({
    id: 'runtime-1',
    userId: 'user-1',
    name: 'Hermes',
    framework: 'hermes',
    kind: 'k8s',
    status: 'ready',
    namespace: 'nca-user-1',
    clusterId: null,
    primaryAgentId: 'agent-1',
    ingressHost: 'agent-1.example.test',
    mountPath: '/home/node/.hermes',
    controlUiEnabled: false,
    dashboardEnabled: false,
    createdAt: new Date('2026-04-28T12:00:00.000Z'),
    updatedAt: new Date('2026-04-28T12:00:00.000Z'),
    ...patch
})

const spec: K8sResourceSpec = {
    agentId: 'agent-1',
    userId: 'user-1',
    namespace: 'nca-user-1',
    framework: 'hermes',
    image: 'hermes:latest',
    port: null,
    host: 'agent-1.example.test',
    storageClass: 'standard',
    pvcMountPath: '/home/node/.hermes',
    envSecretName: 'agent-agent-1-env',
    envSecretKeys: []
}

test('setDashboard refuses to enable Hermes dashboard without MF_AUTH_URL', async () => {
    const calls: string[] = []
    const service = serviceFor({
        runtimes: runtimesFor([runtime()]),
        config: configFor({ K8S_IMAGE_HERMES: 'hermes:latest' }),
        k8s: {
            getClient: async () => {
                calls.push('getClient')
                throw new Error('k8s should not be touched')
            }
        }
    })

    await assert.rejects(
        () => service.setDashboard('user-1', 'runtime-1', true, false),
        (err: unknown) => {
            assert.ok(err instanceof InternalServerErrorException)
            assert.match(
                (err as Error).message,
                /MF_AUTH_URL not set; refusing to enable dashboard ingress/
            )
            return true
        }
    )
    assert.deepEqual(calls, [])
})

test('setDashboard can disable Hermes dashboard without MF_AUTH_URL', async () => {
    const current = runtime({ dashboardEnabled: true })
    const refreshed = runtime({ dashboardEnabled: false })
    const deployment = {
        spec: {
            template: {
                metadata: { annotations: {} as Record<string, string> },
                spec: {
                    containers: [
                        { name: 'hermes' },
                        { name: 'hermes-dashboard' }
                    ]
                }
            }
        }
    }
    const serviceResource = {
        spec: {
            ports: [
                { name: 'http', port: 8642, targetPort: 8642 },
                { name: 'dashboard', port: 8082, targetPort: 9119 }
            ]
        }
    }
    const calls: string[] = []
    const statusPatches: Array<Record<string, unknown>> = []
    const service = serviceFor({
        runtimes: runtimesFor([current, refreshed], statusPatches),
        config: configFor({ K8S_IMAGE_HERMES: 'hermes:latest' }),
        k8s: {
            getClient: async () => ({
                clusterId: null,
                apis: {
                    core: {
                        patchNamespacedSecret: async (args: {
                            body: { stringData: Record<string, string> }
                        }) => {
                            calls.push(
                                `secret:${args.body.stringData.HERMES_DASHBOARD_ENABLED}`
                            )
                        },
                        readNamespacedService: async () => serviceResource,
                        replaceNamespacedService: async () => {
                            calls.push('replace-service')
                        }
                    },
                    apps: {
                        readNamespacedDeployment: async () => deployment,
                        replaceNamespacedDeployment: async () => {
                            calls.push('replace-deployment')
                        }
                    },
                    networking: {
                        deleteNamespacedIngress: async () => {
                            calls.push('delete-ingress')
                        }
                    }
                }
            })
        }
    })

    const result = await service.setDashboard(
        'user-1',
        'runtime-1',
        false,
        false
    )

    assert.equal(result.dashboardEnabled, false)
    assert.deepEqual(statusPatches, [{ dashboardEnabled: false }])
    assert.deepEqual(calls, [
        'secret:false',
        'replace-deployment',
        'replace-service',
        'delete-ingress'
    ])
    assert.deepEqual(deployment.spec.template.spec.containers, [
        { name: 'hermes' }
    ])
    assert.deepEqual(serviceResource.spec.ports, [
        { name: 'http', port: 8642, targetPort: 8642 }
    ])
})

test('buildSidecarIngress requires an auth URL annotation', () => {
    const sidecar = hermesDashboardSidecar(
        'hermes:latest',
        'agent-1.example.test',
        null
    )

    assert.throws(
        () => buildSidecarIngress(spec, sidecar),
        /no authUrlAnnotation; refusing to build public sidecar ingress/
    )
})

test('buildSidecarIngress writes nginx auth-url when configured', () => {
    const authUrl =
        'https://api.manyfold.ai/api/agent-runtimes/runtime-1/dashboard-auth-check'
    const ingress = buildSidecarIngress(
        spec,
        hermesDashboardSidecar('hermes:latest', 'agent-1.example.test', authUrl)
    )

    assert.equal(
        ingress.metadata?.annotations?.['nginx.ingress.kubernetes.io/auth-url'],
        authUrl
    )
})

test('resourceName converts object id underscores to DNS-safe hyphens', () => {
    assert.equal(
        resourceName('agt_abcdefghijklmnopqrstuvwxyz'),
        'agent-agt-abcdefghijklmnopqrstuvwxyz'
    )
})

const serviceFor = (deps: {
    runtimes: unknown
    config: unknown
    k8s: unknown
    db?: unknown
}): K8sRuntimeSidecarService =>
    new K8sRuntimeSidecarService(
        (deps.db ?? auditDb()) as never,
        deps.k8s as never,
        deps.config as never,
        {} as never,
        deps.runtimes as never
    )

const runtimesFor = (
    rows: Array<Record<string, unknown>>,
    statusPatches: Array<Record<string, unknown>> = []
): unknown => {
    const queue = [...rows]
    return {
        findById: async () => queue.shift() ?? rows[rows.length - 1] ?? null,
        toSummary: (row: Record<string, unknown>) => row,
        applyStatusPatch: async (
            _runtimeId: string,
            patch: Record<string, unknown>
        ) => {
            statusPatches.push(patch)
        }
    }
}

const configFor = (values: Record<string, string>): unknown => ({
    get: (key: string) => values[key]
})

const auditDb = (): unknown => ({
    insert: () => ({
        values: async () => undefined
    })
})

test('dashboard auth reads mf_dashboard only; the retired nca_dashboard cookie no longer authenticates', async () => {
    const runtime = {
        framework: 'hermes',
        dashboardEnabled: true,
        userId: 'user-1'
    }
    const bearerAuth = {
        verifyBearerToken: async (token: string) => {
            if (token === 'good-token') return { userId: 'user-1' }
            throw new Error('invalid token')
        }
    }
    const svc = new K8sRuntimeSidecarService(
        auditDb() as never,
        {} as never,
        configFor({}) as never,
        bearerAuth as never,
        { findById: async () => runtime } as never
    )
    assert.equal(
        await svc.checkDashboardAuth('mf_dashboard=good-token', 'runtime-1'),
        true
    )
    // Pre-rename cookie name: Max-Age is one hour, so no nca_dashboard cookie
    // planted before the 2026-06-11 rename can still exist (legacy-inventory).
    assert.equal(
        await svc.checkDashboardAuth('nca_dashboard=good-token', 'runtime-1'),
        false
    )
})
