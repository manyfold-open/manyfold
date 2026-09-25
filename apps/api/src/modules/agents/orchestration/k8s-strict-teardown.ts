import { setTimeout as delay } from 'node:timers/promises'
import { Observable, type ConfigurationOptions } from '@kubernetes/client-node'
import { isApiNotFound, type K8sApis } from '@/modules/k8s/kubernetes.service'
import {
    podHostResourceName,
    podHostSecretName,
    podHostSelector
} from '@/modules/agent-runtimes/provisioning/pod-host-resources'

// Removes every Kubernetes object of a pod host (ADR-0035) and returns only once
// each is gone — a failed fresh create keeps its tracking row until then, and a
// deleted host must not leave its PVC behind.
export const teardownCreatedPodHost = async (args: {
    apis: K8sApis
    namespace: string
    hostId: string
    signal: AbortSignal
}): Promise<void> => {
    const { apis, namespace, hostId, signal } = args
    const name = podHostResourceName(hostId)
    const selector = podHostSelector(hostId)
    const options: ConfigurationOptions = {
        middlewareMergeStrategy: 'append',
        middleware: [
            {
                pre(request) {
                    request.setSignal(signal)
                    return new Observable(Promise.resolve(request))
                },
                post(response) {
                    return new Observable(Promise.resolve(response))
                }
            }
        ]
    }
    const remove = async (
        destroy: () => Promise<unknown>,
        read: () => Promise<unknown>
    ): Promise<void> => {
        signal.throwIfAborted()
        try {
            await destroy()
        } catch (error) {
            if (!isApiNotFound(error)) throw error
        }
        while (true) {
            signal.throwIfAborted()
            try {
                await read()
            } catch (error) {
                if (isApiNotFound(error)) return
                throw error
            }
            await delay(100, undefined, { signal })
        }
    }
    const ingress = (ingressName: string): Promise<void> =>
        remove(
            () =>
                apis.networking.deleteNamespacedIngress(
                    { name: ingressName, namespace },
                    options
                ),
            () =>
                apis.networking.readNamespacedIngress(
                    { name: ingressName, namespace },
                    options
                )
        )
    const ingresses = await apis.networking.listNamespacedIngress(
        { namespace, labelSelector: selector },
        options
    )
    for (const item of ingresses.items ?? []) {
        const ingressName = item.metadata?.name
        if (ingressName) await ingress(ingressName)
    }
    const services = await apis.core.listNamespacedService(
        { namespace, labelSelector: selector },
        options
    )
    for (const item of services.items ?? []) {
        const serviceName = item.metadata?.name
        if (!serviceName) continue
        await remove(
            () =>
                apis.core.deleteNamespacedService(
                    { name: serviceName, namespace },
                    options
                ),
            () =>
                apis.core.readNamespacedService(
                    { name: serviceName, namespace },
                    options
                )
        )
    }
    await remove(
        () =>
            apis.apps.deleteNamespacedDeployment(
                { name, namespace, propagationPolicy: 'Foreground' },
                options
            ),
        () => apis.apps.readNamespacedDeployment({ name, namespace }, options)
    )
    // Deployment deletion can be acknowledged before its pods terminate.
    while (true) {
        signal.throwIfAborted()
        const pods = await apis.core.listNamespacedPod(
            { namespace, labelSelector: selector },
            options
        )
        if ((pods.items?.length ?? 0) === 0) break
        await delay(100, undefined, { signal })
    }
    await remove(
        () =>
            apis.core.deleteNamespacedPersistentVolumeClaim(
                { name, namespace },
                options
            ),
        () =>
            apis.core.readNamespacedPersistentVolumeClaim(
                { name, namespace },
                options
            )
    )
    await remove(
        () =>
            apis.core.deleteNamespacedSecret(
                { name: podHostSecretName(hostId), namespace },
                options
            ),
        () =>
            apis.core.readNamespacedSecret(
                { name: podHostSecretName(hostId), namespace },
                options
            )
    )
}
