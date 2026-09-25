import type {
    V1Deployment,
    V1PersistentVolumeClaim,
    V1Secret
} from '@kubernetes/client-node'
import { K8S_HOME_BASE } from '@manyfold/shared'

// The Kubernetes objects a pod host is made of (ADR-0035): its env Secret, the
// PVC that is the whole home directory, and a one-replica Deployment running
// the generic host image. Every framework on the host lives on that PVC, so
// nothing here names a framework — the objects are keyed by the host alone.
export interface PodHostSpec {
    hostId: string
    userId: string
    namespace: string
    image: string
    storageClass: string
    storageSize: string
    resources: {
        requests: { cpu: string; memory: string }
        limits: { cpu: string; memory: string }
    }
}

const MANAGED_BY = 'netmind-cloud-agent'
// Stable container name so pod-exec callers don't need to know the framework.
export const AGENT_CONTAINER_NAME = 'agent'
// The host image runs as this uid/gid (docker/host); fsGroup makes a freshly
// provisioned PVC writable by it.
const HOST_UID = 1000

export const podHostResourceName = (hostId: string): string =>
    `host-${hostId.replace(/_/g, '-')}`

export const podHostSecretName = (hostId: string): string =>
    `${podHostResourceName(hostId)}-env`

export const POD_HOST_ID_LABEL = 'nca.netmind.ai/host-id'

export const podHostSelector = (hostId: string): string =>
    `${POD_HOST_ID_LABEL}=${hostId}`

const podHostLabels = (spec: PodHostSpec): Record<string, string> => ({
    [POD_HOST_ID_LABEL]: spec.hostId,
    'nca.netmind.ai/user-id': spec.userId,
    'app.kubernetes.io/managed-by': MANAGED_BY
})

export const buildPodHostSecret = (
    spec: PodHostSpec,
    data: Record<string, string>
): V1Secret => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
        name: podHostSecretName(spec.hostId),
        namespace: spec.namespace,
        labels: podHostLabels(spec)
    },
    type: 'Opaque',
    stringData: data
})

export const buildPodHostPvc = (
    spec: PodHostSpec
): V1PersistentVolumeClaim => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
        name: podHostResourceName(spec.hostId),
        namespace: spec.namespace,
        labels: podHostLabels(spec)
    },
    spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: spec.storageClass,
        resources: { requests: { storage: spec.storageSize } }
    }
})

export const buildPodHostDeployment = (spec: PodHostSpec): V1Deployment => {
    const name = podHostResourceName(spec.hostId)
    const labels = podHostLabels(spec)
    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace: spec.namespace, labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            // The PVC is ReadWriteOnce: a rolling update would start the new pod
            // before the old one lets go of it.
            strategy: { type: 'Recreate' },
            template: {
                metadata: { labels },
                spec: {
                    securityContext: {
                        runAsUser: HOST_UID,
                        runAsGroup: HOST_UID,
                        runAsNonRoot: true,
                        fsGroup: HOST_UID,
                        fsGroupChangePolicy: 'OnRootMismatch'
                    },
                    containers: [
                        {
                            name: AGENT_CONTAINER_NAME,
                            image: spec.image,
                            imagePullPolicy: 'IfNotPresent',
                            envFrom: [
                                {
                                    secretRef: {
                                        name: podHostSecretName(spec.hostId)
                                    }
                                }
                            ],
                            volumeMounts: [
                                { name: 'home', mountPath: K8S_HOME_BASE }
                            ],
                            resources: spec.resources
                        }
                    ],
                    volumes: [
                        {
                            name: 'home',
                            persistentVolumeClaim: { claimName: name }
                        }
                    ]
                }
            }
        }
    }
}
