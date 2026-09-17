import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

interface Resource {
    apiVersion: string
    kind: string
    metadata: {
        name: string
        namespace?: string
        uid?: string
        labels?: Record<string, string>
        deletionTimestamp?: string
    }
    spec?: unknown
    status?: unknown
    [key: string]: unknown
}

const kinds: Record<string, string> = {
    namespaces: 'Namespace',
    secrets: 'Secret',
    persistentvolumeclaims: 'PersistentVolumeClaim',
    deployments: 'Deployment',
    services: 'Service',
    ingresses: 'Ingress',
    pods: 'Pod'
}

export class K8sLifecycleFixture {
    readonly resources = new Map<string, Resource>()
    readonly requests: Array<{
        method: string
        collection: string
        name: string
        timeout: string | null
    }> = []
    failCreate: string | null = null
    failDelete: string | null = null
    dropCreateResponse: string | null = null
    terminating: string | null = null
    errorBody: Record<string, unknown> = {}
    beforeDelete?: (collection: string, name: string) => Promise<void>
    beforeCreate?: (collection: string, name: string) => Promise<void>
    afterCreate?: (collection: string, name: string) => Promise<void>
    private server: Server | null = null
    origin = ''
    abortedResponses = 0

    async start(): Promise<void> {
        this.server = createServer((request, response) => {
            response.once('close', () => {
                if (!response.writableEnded) this.abortedResponses++
            })
            const handle = async (): Promise<void> => {
                const url = new URL(
                    request.url ?? '/',
                    'http://fixture.invalid'
                )
                const parts = url.pathname.split('/').filter(Boolean)
                const namespaceIndex = parts.indexOf('namespaces')
                if (namespaceIndex < 0) {
                    response.writeHead(404).end()
                    return
                }
                const isNamespace = parts.length <= namespaceIndex + 2
                const namespace = isNamespace ? '' : parts[namespaceIndex + 1]
                const collection = isNamespace
                    ? 'namespaces'
                    : parts[namespaceIndex + 2]
                let name = isNamespace
                    ? (parts[namespaceIndex + 1] ?? '')
                    : (parts[namespaceIndex + 3] ?? '')
                const method = request.method ?? 'GET'
                const key = (): string => `${namespace}/${collection}/${name}`
                const send = (status: number, body: unknown): void => {
                    response
                        .writeHead(status, {
                            'content-type': 'application/json'
                        })
                        .end(JSON.stringify(body))
                }
                const missing = (): void =>
                    send(404, {
                        apiVersion: 'v1',
                        kind: 'Status',
                        status: 'Failure',
                        reason: 'NotFound',
                        code: 404
                    })
                this.requests.push({
                    method,
                    collection,
                    name,
                    timeout: url.searchParams.get('timeout')
                })
                if (method === 'POST') {
                    if (this.failCreate === collection) {
                        send(503, {
                            kind: 'Status',
                            message: 'fixture create rejected',
                            code: 503,
                            ...this.errorBody
                        })
                        return
                    }
                    const chunks: Buffer[] = []
                    for await (const chunk of request)
                        chunks.push(Buffer.from(chunk))
                    const body = JSON.parse(
                        Buffer.concat(chunks).toString()
                    ) as Resource
                    name = body.metadata.name
                    await this.beforeCreate?.(collection, name)
                    body.metadata.uid = randomUUID()
                    if (namespace) body.metadata.namespace = namespace
                    if (collection === 'deployments') {
                        body.status = { availableReplicas: 1 }
                        this.resources.set(`${namespace}/pods/${name}-0`, {
                            apiVersion: 'v1',
                            kind: 'Pod',
                            metadata: {
                                name: `${name}-0`,
                                namespace,
                                uid: randomUUID(),
                                labels: body.metadata.labels
                            },
                            status: { phase: 'Running' }
                        })
                    }
                    if (collection === 'ingresses')
                        body.status = {
                            loadBalancer: { ingress: [{ ip: '127.0.0.1' }] }
                        }
                    this.resources.set(key(), body)
                    await this.afterCreate?.(collection, name)
                    if (this.dropCreateResponse === collection) {
                        response.destroy()
                        return
                    }
                    send(201, body)
                    return
                }
                if (method === 'GET' && !name) {
                    const selector = url.searchParams.get('labelSelector')
                    const items = [...this.resources.entries()]
                        .filter(([resourceKey]) =>
                            resourceKey.startsWith(
                                `${namespace}/${collection}/`
                            )
                        )
                        .map(([, resource]) => resource)
                        .filter((resource) => {
                            if (!selector) return true
                            const separator = selector.indexOf('=')
                            return (
                                resource.metadata.labels?.[
                                    selector.slice(0, separator)
                                ] === selector.slice(separator + 1)
                            )
                        })
                    send(200, {
                        apiVersion: 'v1',
                        kind: `${kinds[collection]}List`,
                        items
                    })
                    return
                }
                const resource = this.resources.get(key())
                if (!resource) {
                    missing()
                    return
                }
                if (method === 'GET') {
                    send(200, resource)
                    return
                }
                if (method === 'DELETE') {
                    await this.beforeDelete?.(collection, name)
                    if (this.failDelete === collection) {
                        send(503, {
                            kind: 'Status',
                            message: 'fixture delete rejected',
                            code: 503,
                            ...this.errorBody
                        })
                        return
                    }
                    if (this.terminating === collection) {
                        resource.metadata.deletionTimestamp =
                            new Date().toISOString()
                    } else {
                        this.resources.delete(key())
                        if (collection === 'deployments')
                            this.resources.delete(`${namespace}/pods/${name}-0`)
                    }
                    send(200, {
                        apiVersion: 'v1',
                        kind: 'Status',
                        status: 'Success',
                        code: 200
                    })
                    return
                }
                send(405, { kind: 'Status', code: 405 })
            }
            void handle().catch(() => response.writeHead(500).end())
        })
        await new Promise<void>((resolve) =>
            this.server!.listen(0, '127.0.0.1', resolve)
        )
        const address = this.server.address()
        if (!address || typeof address === 'string')
            throw new Error('fixture did not bind')
        this.origin = `http://127.0.0.1:${address.port}`
    }

    kubeconfig(): string {
        return JSON.stringify({
            apiVersion: 'v1',
            kind: 'Config',
            clusters: [
                {
                    name: 'fixture',
                    cluster: {
                        server: this.origin,
                        'insecure-skip-tls-verify': true
                    }
                }
            ],
            contexts: [
                {
                    name: 'fixture',
                    context: { cluster: 'fixture', user: 'fixture' }
                }
            ],
            users: [{ name: 'fixture', user: { token: 'fixture-only' } }],
            'current-context': 'fixture'
        })
    }

    runtimeResources(): Resource[] {
        return [...this.resources.values()].filter(
            (resource) => resource.kind !== 'Namespace'
        )
    }

    async close(): Promise<void> {
        if (!this.server) return
        this.server.closeAllConnections()
        await new Promise<void>((resolve) =>
            this.server!.close(() => resolve())
        )
    }
}
