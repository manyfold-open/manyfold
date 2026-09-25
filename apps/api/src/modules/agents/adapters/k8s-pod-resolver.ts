import type { AgentRuntimeRow } from '@manyfold/db'
import {
    KubernetesService,
    buildApisFromKubeConfig,
    type K8sClient
} from '@/modules/k8s/kubernetes.service'
import {
    AGENT_CONTAINER_NAME,
    podHostSelector
} from '@/modules/agent-runtimes/provisioning/pod-host-resources'

export interface ResolvedAgentPod {
    client: K8sClient
    namespace: string
    podName: string
    containerName: string
}

// The pod a pod host is (ADR-0035), found by its host-id label: the objects
// carry no framework, runtime or agent labels, so every framework runtime and
// agent on the host resolves to this one pod.
export const resolvePodHostPod = async (
    k8s: KubernetesService,
    host: {
        hostId: string
        clusterId: string | null
        namespace: string | null
        // The caller's client for this cluster, when it already has one.
        client?: K8sClient
    }
): Promise<ResolvedAgentPod> => {
    if (!host.namespace)
        throw new Error(
            `pod host ${host.hostId} has no k8s namespace; cannot resolve pod`
        )
    const client = host.client ?? (await k8s.getClient(host.clusterId))
    const apis = buildApisFromKubeConfig(client.kubeConfig)
    const labelSelector = podHostSelector(host.hostId)
    const res = await apis.core.listNamespacedPod({
        namespace: host.namespace,
        labelSelector
    })
    const pods = res.items ?? []
    const pod =
        pods.find((p) => p.status?.phase === 'Running') ??
        pods.find((p) => p.status?.phase === 'Pending')
    if (!pod?.metadata?.name)
        throw new Error(
            `no pod found for pod host ${host.hostId} (selector=${labelSelector})`
        )
    const containerName =
        (pod.spec?.containers ?? []).find(
            (c) => c.name === AGENT_CONTAINER_NAME
        )?.name ?? pod.spec?.containers?.[0]?.name
    if (!containerName)
        throw new Error(
            `pod ${pod.metadata.name} has no containers to exec into`
        )
    return {
        client,
        namespace: host.namespace,
        podName: pod.metadata.name,
        containerName
    }
}

export const resolveAgentPod = async (
    k8s: KubernetesService,
    runtime: AgentRuntimeRow
): Promise<ResolvedAgentPod> => {
    if (!runtime.hostId)
        throw new Error(
            `runtime ${runtime.id} is not on a pod host; cannot resolve pod`
        )
    return resolvePodHostPod(k8s, {
        hostId: runtime.hostId,
        clusterId: runtime.clusterId,
        namespace: runtime.namespace
    })
}
