import { Logger } from '@nestjs/common'
import type { K8sApis } from '@/modules/k8s/kubernetes.service'
import { isApiNotFound } from '@/modules/k8s/kubernetes.service'
import { resourceName } from '@/modules/agents/orchestration/k8s-resource-builder'

export interface TeardownRequest {
    apis: K8sApis
    namespace: string
    agentId: string
    envSecretName: string
    ignoreNotFound?: boolean
    logger?: Logger
}

const step = async (
    label: string,
    fn: () => Promise<unknown>,
    ignoreNotFound: boolean,
    logger?: Logger
): Promise<void> => {
    try {
        await fn()
    } catch (err) {
        if (ignoreNotFound && isApiNotFound(err)) return
        logger?.warn(`teardown ${label} failed: ${(err as Error).message}`)
        throw err
    }
}

export const teardownAgent = async (req: TeardownRequest): Promise<void> => {
    const ignoreNotFound = req.ignoreNotFound ?? true
    const name = resourceName(req.agentId)
    const { apis, namespace, envSecretName, logger } = req

    await step(
        'ingress',
        () => apis.networking.deleteNamespacedIngress({ name, namespace }),
        ignoreNotFound,
        logger
    )
    await step(
        'sidecar-ingresses',
        async () => {
            const list = await apis.networking.listNamespacedIngress({
                namespace,
                labelSelector: `nca.netmind.ai/agent-id=${req.agentId}`
            })
            for (const ing of list.items ?? []) {
                const ingName = ing.metadata?.name
                if (!ingName || ingName === name) continue
                await apis.networking.deleteNamespacedIngress({
                    name: ingName,
                    namespace
                })
            }
        },
        ignoreNotFound,
        logger
    )
    await step(
        'service',
        () => apis.core.deleteNamespacedService({ name, namespace }),
        ignoreNotFound,
        logger
    )
    await step(
        'deployment',
        () => apis.apps.deleteNamespacedDeployment({ name, namespace }),
        ignoreNotFound,
        logger
    )
    await step(
        'pvc',
        () =>
            apis.core.deleteNamespacedPersistentVolumeClaim({
                name,
                namespace
            }),
        ignoreNotFound,
        logger
    )
    await step(
        'secret',
        () =>
            apis.core.deleteNamespacedSecret({
                name: envSecretName,
                namespace
            }),
        ignoreNotFound,
        logger
    )
}
