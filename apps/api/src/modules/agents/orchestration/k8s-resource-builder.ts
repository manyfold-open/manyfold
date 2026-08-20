import type {
    V1Container,
    V1Deployment,
    V1Ingress,
    V1PersistentVolumeClaim,
    V1Probe,
    V1Secret,
    V1Service
} from '@kubernetes/client-node'
import type {
    K8sFramework,
    K8sSidecarSpec
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'

export interface K8sResourceSpec {
    agentId: string
    // When set, identifies the multi-agent container runtime hosting this pod.
    // Used as an additional label so the pod can be discovered before any agent
    // is registered (e.g. during container provisioning).
    runtimeId?: string
    userId: string
    namespace: string
    framework: K8sFramework
    image: string
    port: number | null
    host: string
    storageClass: string
    storageSize?: string
    pvcMountPath: string
    envSecretName: string
    envSecretKeys: string[]
    readinessProbe?: V1Probe | null
    resources?: {
        requests?: { cpu?: string; memory?: string }
        limits?: { cpu?: string; memory?: string }
    }
    sidecars?: K8sSidecarSpec[]
}

const DEFAULT_RESOURCES = {
    requests: { cpu: '100m', memory: '256Mi' },
    limits: { cpu: '500m', memory: '512Mi' }
}

const MANAGED_BY = 'netmind-cloud-agent'

// Stable container name so pod-exec callers don't need to know the framework.
export const AGENT_CONTAINER_NAME = 'agent'

const DUFS_IMAGE = 'sigoden/dufs:v0.45.0'
// Pod-internal port; must not collide with any framework's main container port
// (hermes=8080, openclaw=18789). 38080 picked to stay well above user ranges.
export const FILES_CONTAINER_PORT = 38080
const FILES_SERVICE_PORT = 8081

const filesBaseUrlPath = (agentId: string): string =>
    `/api/agents/${agentId}/files`

const baseLabels = (spec: K8sResourceSpec): Record<string, string> => {
    const labels: Record<string, string> = {
        'nca.netmind.ai/agent-id': spec.agentId,
        'nca.netmind.ai/user-id': spec.userId,
        'nca.netmind.ai/framework': spec.framework,
        'app.kubernetes.io/managed-by': MANAGED_BY
    }
    if (spec.runtimeId)
        labels['nca.netmind.ai/runtime-id'] = spec.runtimeId
    return labels
}

export const resourceName = (agentId: string): string =>
    `agent-${agentId.replace(/_/g, '-')}`

export const buildSecret = (
    spec: K8sResourceSpec,
    data: Record<string, string>
): V1Secret => ({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
        name: spec.envSecretName,
        namespace: spec.namespace,
        labels: baseLabels(spec)
    },
    type: 'Opaque',
    stringData: data
})

export const buildPvc = (spec: K8sResourceSpec): V1PersistentVolumeClaim => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
        name: resourceName(spec.agentId),
        namespace: spec.namespace,
        labels: baseLabels(spec)
    },
    spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: spec.storageClass,
        resources: { requests: { storage: spec.storageSize ?? '1Gi' } }
    }
})

export const buildDeployment = (spec: K8sResourceSpec): V1Deployment => {
    const name = resourceName(spec.agentId)
    const labels = baseLabels(spec)
    const envFrom = [{ secretRef: { name: spec.envSecretName } }]
    const container: V1Container = {
        name: AGENT_CONTAINER_NAME,
        image: spec.image,
        imagePullPolicy: 'IfNotPresent',
        envFrom,
        volumeMounts: [{ name: 'data', mountPath: spec.pvcMountPath }],
        resources: spec.resources ?? DEFAULT_RESOURCES
    }
    if (spec.port !== null)
        container.ports = [{ containerPort: spec.port, name: 'http' }]
    if (spec.readinessProbe) container.readinessProbe = spec.readinessProbe

    const files = {
        name: 'dufs',
        image: DUFS_IMAGE,
        imagePullPolicy: 'IfNotPresent',
        args: [
            spec.pvcMountPath,
            '--bind',
            '0.0.0.0',
            '--port',
            String(FILES_CONTAINER_PORT),
            '--path-prefix',
            filesBaseUrlPath(spec.agentId),
            '--allow-upload',
            '--allow-delete',
            '--log-format',
            ''
        ],
        ports: [{ containerPort: FILES_CONTAINER_PORT, name: 'files' }],
        volumeMounts: [{ name: 'data', mountPath: spec.pvcMountPath }],
        resources: {
            requests: { cpu: '20m', memory: '32Mi' },
            limits: { cpu: '200m', memory: '128Mi' }
        }
    }
    const sidecarContainers: V1Container[] = (spec.sidecars ?? []).map(
        (sidecar) => {
            const s: V1Container = {
                name: sidecar.name,
                image: sidecar.image,
                imagePullPolicy: 'IfNotPresent',
                ports: [
                    {
                        containerPort: sidecar.containerPort,
                        name: sidecar.servicePortName
                    }
                ],
                resources: sidecar.resources ?? {
                    requests: { cpu: '50m', memory: '64Mi' },
                    limits: { cpu: '300m', memory: '256Mi' }
                }
            }
            if (sidecar.command) s.command = sidecar.command
            if (sidecar.args) s.args = sidecar.args
            if (sidecar.envFromMainSecret) s.envFrom = envFrom
            if (sidecar.mountPvc)
                s.volumeMounts = [
                    { name: 'data', mountPath: spec.pvcMountPath }
                ]
            return s
        }
    )
    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name, namespace: spec.namespace, labels },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            strategy: { type: 'Recreate' },
            template: {
                metadata: { labels },
                spec: {
                    containers: [container, files, ...sidecarContainers],
                    volumes: [
                        {
                            name: 'data',
                            persistentVolumeClaim: { claimName: name }
                        }
                    ]
                }
            }
        }
    }
}

export const buildService = (spec: K8sResourceSpec): V1Service => {
    const name = resourceName(spec.agentId)
    const ports: Array<{
        name: string
        port: number
        targetPort: number
        protocol: string
    }> = []
    if (spec.port !== null) {
        ports.push({
            name: 'http',
            port: 80,
            targetPort: spec.port,
            protocol: 'TCP'
        })
    }
    ports.push({
        name: 'files',
        port: FILES_SERVICE_PORT,
        targetPort: FILES_CONTAINER_PORT,
        protocol: 'TCP'
    })
    for (const sidecar of spec.sidecars ?? []) {
        ports.push({
            name: sidecar.servicePortName,
            port: sidecar.servicePort,
            targetPort: sidecar.containerPort,
            protocol: 'TCP'
        })
    }
    return {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
            name,
            namespace: spec.namespace,
            labels: baseLabels(spec)
        },
        spec: {
            type: 'ClusterIP',
            selector: baseLabels(spec),
            ports
        }
    }
}

export const sidecarIngressName = (
    agentId: string,
    sidecarName: string
): string => `${resourceName(agentId)}-${sidecarName}`

export const buildSidecarIngress = (
    spec: K8sResourceSpec,
    sidecar: K8sSidecarSpec
): V1Ingress => {
    if (!sidecar.ingressPath)
        throw new Error(
            `sidecar ${sidecar.name} has no ingressPath — cannot build ingress`
        )
    if (!sidecar.authUrlAnnotation)
        throw new Error(
            `sidecar ${sidecar.name} has no authUrlAnnotation; refusing to build public sidecar ingress`
        )
    const name = sidecarIngressName(spec.agentId, sidecar.name)
    const annotations: Record<string, string> = {
        'nginx.ingress.kubernetes.io/auth-url': sidecar.authUrlAnnotation
    }
    if (sidecar.authSigninAnnotation)
        annotations['nginx.ingress.kubernetes.io/auth-signin'] =
            sidecar.authSigninAnnotation
    return {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
            name,
            namespace: spec.namespace,
            labels: {
                ...baseLabels(spec),
                'nca.netmind.ai/sidecar': sidecar.name
            },
            annotations
        },
        spec: {
            ingressClassName: 'nginx',
            rules: [
                {
                    host: sidecar.ingressHost ?? spec.host,
                    http: {
                        paths: [
                            {
                                path: sidecar.ingressPath,
                                pathType: sidecar.ingressPathType ?? 'Prefix',
                                backend: {
                                    service: {
                                        name: resourceName(spec.agentId),
                                        port: { number: sidecar.servicePort }
                                    }
                                }
                            }
                        ]
                    }
                }
            ]
        }
    }
}

export const buildIngress = (spec: K8sResourceSpec): V1Ingress => {
    const name = resourceName(spec.agentId)
    const paths: Array<{
        path: string
        pathType: string
        backend: {
            service: { name: string; port: { number: number } }
        }
    }> = [
        {
            path: filesBaseUrlPath(spec.agentId),
            pathType: 'Prefix',
            backend: {
                service: {
                    name,
                    port: { number: FILES_SERVICE_PORT }
                }
            }
        }
    ]
    if (spec.port !== null) {
        paths.push({
            path: '/',
            pathType: 'Prefix',
            backend: {
                service: { name, port: { number: 80 } }
            }
        })
    }
    return {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        metadata: {
            name,
            namespace: spec.namespace,
            labels: baseLabels(spec),
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
                    host: spec.host,
                    http: { paths }
                }
            ]
        }
    }
}
