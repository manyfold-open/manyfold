import { ApiException, type V1Service } from '@kubernetes/client-node'
import { isApiNotFound, type K8sApis } from '@/modules/k8s/kubernetes.service'
import {
    buildPodHostIngress,
    buildPodHostService,
    podHostFrameworkIngressHost,
    podHostIngressName,
    podHostResourceName
} from './pod-host-resources'

interface PodHostRef {
    hostId: string
    userId: string
    namespace: string
}

const isApiConflict = (err: unknown): boolean =>
    err instanceof ApiException && err.code === 409

const readService = async (
    apis: K8sApis,
    host: PodHostRef
): Promise<V1Service | null> => {
    try {
        return await apis.core.readNamespacedService({
            name: podHostResourceName(host.hostId),
            namespace: host.namespace
        })
    } catch (err) {
        if (isApiNotFound(err)) return null
        throw err
    }
}

const writeService = async (
    apis: K8sApis,
    host: PodHostRef,
    existing: V1Service | null,
    ports: Array<{ framework: string; port: number }>
): Promise<void> => {
    const name = podHostResourceName(host.hostId)
    if (ports.length === 0) {
        if (!existing) return
        try {
            await apis.core.deleteNamespacedService({
                name,
                namespace: host.namespace
            })
        } catch (err) {
            if (!isApiNotFound(err)) throw err
        }
        return
    }
    const body = buildPodHostService(host, ports)
    if (!existing) {
        await apis.core.createNamespacedService({
            namespace: host.namespace,
            body
        })
        return
    }
    body.metadata = {
        ...body.metadata,
        resourceVersion: existing.metadata?.resourceVersion
    }
    body.spec = { ...body.spec, clusterIP: existing.spec?.clusterIP }
    await apis.core.replaceNamespacedService({
        name,
        namespace: host.namespace,
        body
    })
}

const portsBesides = (
    service: V1Service | null,
    framework: string
): Array<{ framework: string; port: number }> =>
    (service?.spec?.ports ?? [])
        .filter((p) => p.name && p.name !== framework)
        .map((p) => ({ framework: p.name as string, port: p.port }))

// Routes a service framework on the host to its own hostname (ADR-0035 §7):
// its port joins the host's Service, and an Ingress names it. Returns the
// hostname. Idempotent, so a retried setup converges.
export const exposePodHostFramework = async (args: {
    apis: K8sApis
    host: PodHostRef
    framework: string
    port: number
    suffix: string
}): Promise<string> => {
    const { apis, host, framework, port } = args
    const service = await readService(apis, host)
    await writeService(apis, host, service, [
        ...portsBesides(service, framework),
        { framework, port }
    ])
    const ingressHost = podHostFrameworkIngressHost(
        host.hostId,
        framework,
        args.suffix
    )
    const body = buildPodHostIngress(host, framework, ingressHost, port)
    try {
        await apis.networking.createNamespacedIngress({
            namespace: host.namespace,
            body
        })
    } catch (err) {
        if (!isApiConflict(err)) throw err
        const current = await apis.networking.readNamespacedIngress({
            name: podHostIngressName(host.hostId, framework),
            namespace: host.namespace
        })
        body.metadata = {
            ...body.metadata,
            resourceVersion: current.metadata?.resourceVersion
        }
        await apis.networking.replaceNamespacedIngress({
            name: podHostIngressName(host.hostId, framework),
            namespace: host.namespace,
            body
        })
    }
    return ingressHost
}

// The reverse, when the framework leaves the host.
export const withdrawPodHostFramework = async (args: {
    apis: K8sApis
    host: PodHostRef
    framework: string
}): Promise<void> => {
    const { apis, host, framework } = args
    try {
        await apis.networking.deleteNamespacedIngress({
            name: podHostIngressName(host.hostId, framework),
            namespace: host.namespace
        })
    } catch (err) {
        if (!isApiNotFound(err)) throw err
    }
    const service = await readService(apis, host)
    await writeService(apis, host, service, portsBesides(service, framework))
}
