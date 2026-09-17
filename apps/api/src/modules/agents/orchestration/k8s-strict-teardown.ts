import { setTimeout as delay } from 'node:timers/promises'
import { Observable, type ConfigurationOptions } from '@kubernetes/client-node'
import { isApiNotFound, type K8sApis } from '@/modules/k8s/kubernetes.service'
import { resourceName } from './k8s-resource-builder'

// Failed fresh creates keep their tracking row until every owned resource is
// absent. The ordinary explicit/purchased teardown retains its older contract.
export const teardownCreatedK8sRuntime = async (args: {
    apis: K8sApis
    namespace: string
    runtimeId: string
    signal: AbortSignal
}): Promise<void> => {
    const { apis, namespace, runtimeId, signal } = args
    const name = resourceName(runtimeId)
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
    await ingress(name)
    const sidecars = await apis.networking.listNamespacedIngress(
        {
            namespace,
            labelSelector: `nca.netmind.ai/agent-id=${runtimeId}`
        },
        options
    )
    for (const sidecar of sidecars.items ?? []) {
        const sidecarName = sidecar.metadata?.name
        if (sidecarName && sidecarName !== name) await ingress(sidecarName)
    }
    await remove(
        () => apis.core.deleteNamespacedService({ name, namespace }, options),
        () => apis.core.readNamespacedService({ name, namespace }, options)
    )
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
            {
                namespace,
                labelSelector: `nca.netmind.ai/agent-id=${runtimeId}`
            },
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
                { name: `${name}-env`, namespace },
                options
            ),
        () =>
            apis.core.readNamespacedSecret(
                { name: `${name}-env`, namespace },
                options
            )
    )
}
