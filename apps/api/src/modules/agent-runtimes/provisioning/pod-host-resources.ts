import type {
    V1Deployment,
    V1Ingress,
    V1PersistentVolumeClaim,
    V1Secret,
    V1Service
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

type PodHostRef = Pick<PodHostSpec, 'hostId' | 'userId' | 'namespace'>

const podHostLabels = (spec: PodHostRef): Record<string, string> => ({
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

// The ports of the service frameworks on the host, one per framework
// (ADR-0035 §7), behind a Service named after the host.
export const buildPodHostService = (
    host: PodHostRef,
    ports: ReadonlyArray<{ framework: string; port: number }>
): V1Service => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
        name: podHostResourceName(host.hostId),
        namespace: host.namespace,
        labels: podHostLabels(host)
    },
    spec: {
        type: 'ClusterIP',
        selector: { [POD_HOST_ID_LABEL]: host.hostId },
        ports: ports.map((p) => ({
            name: p.framework,
            port: p.port,
            targetPort: p.port,
            protocol: 'TCP'
        }))
    }
})

// Each service framework gets a hostname of its own, because the gateways
// and UIs behind them assume they are mounted at `/`.
export const podHostFrameworkIngressHost = (
    hostId: string,
    framework: string,
    suffix: string
): string => `${framework}-${podHostResourceName(hostId)}.${suffix}`

export const podHostIngressName = (hostId: string, framework: string): string =>
    `${podHostResourceName(hostId)}-${framework}`

export const buildPodHostIngress = (
    host: PodHostRef,
    framework: string,
    ingressHost: string,
    port: number
): V1Ingress => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
        name: podHostIngressName(host.hostId, framework),
        namespace: host.namespace,
        labels: podHostLabels(host),
        annotations: {
            'nginx.ingress.kubernetes.io/proxy-read-timeout': '600',
            'nginx.ingress.kubernetes.io/proxy-send-timeout': '600',
            'nginx.ingress.kubernetes.io/proxy-buffering': 'off'
        }
    },
    spec: {
        ingressClassName: 'nginx',
        rules: [
            {
                host: ingressHost,
                http: {
                    paths: [
                        {
                            path: '/',
                            pathType: 'Prefix',
                            backend: {
                                service: {
                                    name: podHostResourceName(host.hostId),
                                    port: { number: port }
                                }
                            }
                        }
                    ]
                }
            }
        ]
    }
})
