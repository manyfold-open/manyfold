import type { V1Pod } from '@kubernetes/client-node'
import type { K8sClient } from '@/modules/k8s/kubernetes.service'

const FAILURE_REASONS = new Set<string>([
    'CrashLoopBackOff',
    'ImagePullBackOff',
    'ErrImagePull',
    'CreateContainerConfigError',
    'CreateContainerError',
    'InvalidImageName'
])

const STARTING_REASONS = new Set<string>([
    'ContainerCreating',
    'PodInitializing'
])

export const derivePodPhase = (pod: V1Pod | undefined): string | null => {
    if (!pod) return null
    const statuses = pod.status?.containerStatuses ?? []
    for (const status of statuses) {
        const reason = status.state?.waiting?.reason
        if (reason && FAILURE_REASONS.has(reason)) return reason
    }
    const phase = pod.status?.phase ?? null
    if (phase === 'Running') {
        const ready = statuses.length > 0 && statuses.every((s) => s.ready)
        if (ready) return 'Running'
        const startingReason = statuses
            .map((s) => s.state?.waiting?.reason)
            .find((r): r is string => Boolean(r) && STARTING_REASONS.has(r!))
        return startingReason ?? 'NotReady'
    }
    if (phase === 'Pending') {
        const startingReason = statuses
            .map((s) => s.state?.waiting?.reason)
            .find((r): r is string => Boolean(r) && STARTING_REASONS.has(r!))
        return startingReason ?? 'Pending'
    }
    return phase
}

export const fetchPodForRuntime = async (
    client: K8sClient,
    namespace: string,
    agentIdLabel: string
): Promise<V1Pod | undefined> => {
    const res = await client.apis.core.listNamespacedPod({
        namespace,
        labelSelector: `nca.netmind.ai/agent-id=${agentIdLabel}`
    })
    return (
        res.items.find((item) => item.status?.phase === 'Running') ??
        res.items[0]
    )
}
