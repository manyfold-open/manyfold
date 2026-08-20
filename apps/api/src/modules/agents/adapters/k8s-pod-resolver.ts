import type { AgentRuntimeRow } from '@manyfold/db'
import {
    KubernetesService,
    buildApisFromKubeConfig,
    type K8sClient
} from '@/modules/k8s/kubernetes.service'
import { AGENT_CONTAINER_NAME } from '@/modules/agents/orchestration/k8s-resource-builder'

export interface ResolvedAgentPod {
    client: K8sClient
    namespace: string
    podName: string
    containerName: string
}

const SIDECAR_CONTAINER_NAMES = new Set([
    'dufs',
    'hermes-dashboard',
    'openclaw-dashboard'
])

export const resolveAgentPod = async (
    k8s: KubernetesService,
    runtime: AgentRuntimeRow,
    primaryAgentId: string | null
): Promise<ResolvedAgentPod> => {
    if (!runtime.namespace)
        throw new Error(
            `runtime ${runtime.id} has no k8s namespace; cannot resolve pod`
        )
    const client = await k8s.getClient(runtime.clusterId)
    const apis = buildApisFromKubeConfig(client.kubeConfig)
    // Prefer the agent-id label (grandfathered single-agent runtimes); fall
    // back to runtime-id when no primary agent is set (container-purchase
    // model pods are labeled by runtime-id from creation).
    const labelSelector = primaryAgentId
        ? `nca.netmind.ai/agent-id=${primaryAgentId}`
        : `nca.netmind.ai/runtime-id=${runtime.id}`
    const res = await apis.core.listNamespacedPod({
        namespace: runtime.namespace,
        labelSelector
    })
    const pods = res.items ?? []
    const pod =
        pods.find((p) => p.status?.phase === 'Running') ??
        pods.find((p) => p.status?.phase === 'Pending')
    if (!pod?.metadata?.name)
        throw new Error(
            `no pod found for runtime ${runtime.id} (selector=${labelSelector})`
        )
    const podContainerNames = (pod.spec?.containers ?? [])
        .map((c) => c.name)
        .filter((n): n is string => !!n)
    const containerName =
        podContainerNames.find((n) => n === AGENT_CONTAINER_NAME) ??
        podContainerNames.find((n) => !SIDECAR_CONTAINER_NAMES.has(n)) ??
        podContainerNames[0]
    if (!containerName)
        throw new Error(
            `pod ${pod.metadata.name} has no containers to exec into`
        )
    return {
        client,
        namespace: runtime.namespace,
        podName: pod.metadata.name,
        containerName
    }
}
