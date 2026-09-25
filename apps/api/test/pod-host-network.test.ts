import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiException, type V1Ingress, type V1Service } from '@kubernetes/client-node'
import {
    exposePodHostFramework,
    withdrawPodHostFramework
} from '../src/modules/agent-runtimes/provisioning/pod-host-network'

// A service framework on a cloud computer gets its own hostname (ADR-0035
// §7): its port joins the host's one Service and an Ingress names it. Both
// calls are idempotent, so a retried setup or teardown converges.

const HOST = { hostId: 'pdh_1', userId: 'usr_1', namespace: 'nca-user-1' }

const apiError = (code: number) => new ApiException(code, 'k8s', {}, {})

const fakeCluster = () => {
    let service: V1Service | null = null
    const ingresses = new Map<string, V1Ingress>()
    let revision = 0
    const calls: string[] = []
    const apis = {
        core: {
            readNamespacedService: async () => {
                if (!service) throw apiError(404)
                return service
            },
            createNamespacedService: async ({ body }: { body: V1Service }) => {
                calls.push('service.create')
                service = {
                    ...body,
                    metadata: { ...body.metadata, resourceVersion: String(++revision) },
                    spec: { ...body.spec, clusterIP: '10.0.0.7' }
                }
            },
            replaceNamespacedService: async ({ body }: { body: V1Service }) => {
                calls.push('service.replace')
                assert.equal(body.metadata?.resourceVersion, service?.metadata?.resourceVersion)
                assert.equal(body.spec?.clusterIP, '10.0.0.7')
                service = { ...body, metadata: { ...body.metadata, resourceVersion: String(++revision) } }
            },
            deleteNamespacedService: async () => {
                calls.push('service.delete')
                service = null
            }
        },
        networking: {
            createNamespacedIngress: async ({ body }: { body: V1Ingress }) => {
                const name = body.metadata?.name as string
                if (ingresses.has(name)) throw apiError(409)
                calls.push('ingress.create')
                ingresses.set(name, { ...body, metadata: { ...body.metadata, resourceVersion: '1' } })
            },
            readNamespacedIngress: async ({ name }: { name: string }) => {
                const found = ingresses.get(name)
                if (!found) throw apiError(404)
                return found
            },
            replaceNamespacedIngress: async ({ name, body }: { name: string; body: V1Ingress }) => {
                calls.push('ingress.replace')
                assert.equal(body.metadata?.resourceVersion, '1')
                ingresses.set(name, body)
            },
            deleteNamespacedIngress: async ({ name }: { name: string }) => {
                if (!ingresses.delete(name)) throw apiError(404)
                calls.push('ingress.delete')
            }
        }
    }
    return {
        apis: apis as never,
        calls,
        ports: () => (service?.spec?.ports ?? []).map((p) => `${p.name}:${p.port}`),
        ingressHosts: () => [...ingresses.values()].map((i) => i.spec?.rules?.[0]?.host)
    }
}

test('two frameworks share the host Service and get a hostname each', async () => {
    const cluster = fakeCluster()
    const openclaw = await exposePodHostFramework({
        apis: cluster.apis,
        host: HOST,
        framework: 'openclaw',
        port: 18789,
        suffix: 'example.test'
    })
    assert.equal(openclaw, 'openclaw-host-pdh-1.example.test')
    await exposePodHostFramework({
        apis: cluster.apis,
        host: HOST,
        framework: 'hermes',
        port: 8642,
        suffix: 'example.test'
    })
    assert.deepEqual(cluster.ports(), ['openclaw:18789', 'hermes:8642'])
    assert.deepEqual(cluster.ingressHosts(), [
        'openclaw-host-pdh-1.example.test',
        'hermes-host-pdh-1.example.test'
    ])
    assert.deepEqual(cluster.calls, [
        'service.create',
        'ingress.create',
        'service.replace',
        'ingress.create'
    ])
})

test('a retried setup replaces what is already there', async () => {
    const cluster = fakeCluster()
    const expose = () =>
        exposePodHostFramework({
            apis: cluster.apis,
            host: HOST,
            framework: 'openclaw',
            port: 18789,
            suffix: 'example.test'
        })
    await expose()
    await expose()
    assert.deepEqual(cluster.ports(), ['openclaw:18789'])
    assert.deepEqual(cluster.calls, [
        'service.create',
        'ingress.create',
        'service.replace',
        'ingress.replace'
    ])
})

test('withdrawing keeps the other framework, and the last one takes the Service', async () => {
    const cluster = fakeCluster()
    for (const [framework, port] of [
        ['openclaw', 18789],
        ['hermes', 8642]
    ] as const)
        await exposePodHostFramework({
            apis: cluster.apis,
            host: HOST,
            framework,
            port,
            suffix: 'example.test'
        })
    await withdrawPodHostFramework({ apis: cluster.apis, host: HOST, framework: 'openclaw' })
    assert.deepEqual(cluster.ports(), ['hermes:8642'])
    assert.deepEqual(cluster.ingressHosts(), ['hermes-host-pdh-1.example.test'])

    await withdrawPodHostFramework({ apis: cluster.apis, host: HOST, framework: 'hermes' })
    assert.deepEqual(cluster.ports(), [])
    assert.equal(cluster.calls.at(-1), 'service.delete')

    // Nothing left: a repeat is a no-op, not an error.
    await withdrawPodHostFramework({ apis: cluster.apis, host: HOST, framework: 'hermes' })
})
