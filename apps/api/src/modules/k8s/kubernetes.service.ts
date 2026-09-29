import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, asc, desc, eq } from 'drizzle-orm'
import {
    AppsV1Api,
    CoreV1Api,
    KubeConfig,
    NetworkingV1Api,
    ApiException
} from '@kubernetes/client-node'
import { runtimeProviders, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    AGENT_CONTAINER_NAME,
    podHostSelector
} from '@/modules/hosts/providers/pod-host-resources'

const NAMESPACE_PREFIX = 'nca-user-'
const ENV_CACHE_KEY = '__env__'

export interface K8sApis {
    core: CoreV1Api
    apps: AppsV1Api
    networking: NetworkingV1Api
}

export interface K8sClient {
    // The runtime_providers row (kind k8s) this client was built from; null
    // for the KUBECONFIG env fallback.
    providerId: string | null
    hostSuffix: string | null
    apis: K8sApis
    kubeConfig: KubeConfig
}

export interface HostPod {
    podName: string
    containerName: string
    phase: string | null
}

interface CachedClient {
    version: string
    client: K8sClient
}

export const isApiNotFound = (err: unknown): boolean =>
    err instanceof ApiException && err.code === 404

export const isApiConflict = (err: unknown): boolean =>
    err instanceof ApiException && err.code === 409

const userNamespace = (userId: string): string => {
    const safe = userId
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
    if (!safe) throw new Error('userId yields empty namespace suffix')
    return `${NAMESPACE_PREFIX}${safe}`
}

export const buildApisFromKubeConfig = (kc: KubeConfig): K8sApis => ({
    core: kc.makeApiClient(CoreV1Api),
    apps: kc.makeApiClient(AppsV1Api),
    networking: kc.makeApiClient(NetworkingV1Api)
})

@Injectable()
export class KubernetesService {
    private readonly log = new Logger(KubernetesService.name)
    private readonly cache: Map<string, CachedClient> = new Map()
    private readonly envKubeconfigPath: string | null

    constructor(
        private readonly config: ConfigService,
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {
        this.envKubeconfigPath = this.config.get<string>('KUBECONFIG') ?? null
        if (!this.envKubeconfigPath)
            this.log.log(
                'KUBECONFIG env not set; k8s runtime requires a registered k8s runtime provider'
            )
    }

    // The client for a k8s runtime provider, or — with null — the highest
    // priority enabled one, falling back to the KUBECONFIG env.
    async getClient(providerId: string | null): Promise<K8sClient> {
        if (providerId) return this.resolveProvider(providerId)
        return this.resolveDefaultClient()
    }

    async ensureUserNamespace(
        client: K8sClient,
        userId: string
    ): Promise<string> {
        const name = userNamespace(userId)
        const { core } = client.apis
        try {
            await core.readNamespace({ name })
            return name
        } catch (err) {
            if (!isApiNotFound(err)) throw err
        }
        try {
            await core.createNamespace({
                body: {
                    apiVersion: 'v1',
                    kind: 'Namespace',
                    metadata: {
                        name,
                        labels: {
                            'nca.netmind.ai/user-id': userId,
                            'app.kubernetes.io/managed-by':
                                'netmind-cloud-agent'
                        }
                    }
                }
            })
        } catch (err) {
            if (isApiConflict(err)) return name
            throw err
        }
        return name
    }

    // The pod a pod host is (ADR-0035), found by its host-id label: the
    // objects carry no framework, runtime or agent labels, so everything on
    // the host resolves to this one pod.
    async findHostPod(
        client: K8sClient,
        hostId: string,
        namespace: string
    ): Promise<HostPod> {
        const pod = await this.findHostPodIfAny(client, hostId, namespace)
        if (!pod)
            throw new Error(
                `no pod found for pod host ${hostId} (selector=${podHostSelector(hostId)})`
            )
        return pod
    }

    async findHostPodIfAny(
        client: K8sClient,
        hostId: string,
        namespace: string
    ): Promise<HostPod | null> {
        const res = await client.apis.core.listNamespacedPod({
            namespace,
            labelSelector: podHostSelector(hostId)
        })
        const pods = res.items ?? []
        const pod =
            pods.find((p) => p.status?.phase === 'Running') ??
            pods.find((p) => p.status?.phase === 'Pending') ??
            pods[0]
        if (!pod?.metadata?.name) return null
        const containerName =
            (pod.spec?.containers ?? []).find(
                (c) => c.name === AGENT_CONTAINER_NAME
            )?.name ?? pod.spec?.containers?.[0]?.name
        if (!containerName)
            throw new Error(
                `pod ${pod.metadata.name} has no containers to exec into`
            )
        return {
            podName: pod.metadata.name,
            containerName,
            phase: pod.status?.phase ?? null
        }
    }

    invalidate(providerId: string): void {
        this.cache.delete(providerId)
    }

    async probeKubeconfig(
        kubeconfigYaml: string
    ): Promise<{ ok: boolean; message: string }> {
        let kc: KubeConfig
        try {
            kc = new KubeConfig()
            kc.loadFromString(kubeconfigYaml)
        } catch (err) {
            return {
                ok: false,
                message: `kubeconfig parse failed: ${(err as Error).message}`
            }
        }
        try {
            const core = kc.makeApiClient(CoreV1Api)
            const res = await core.listNamespace({ limit: 1 })
            const count = res.items?.length ?? 0
            return {
                ok: true,
                message: `reachable (listed ${count} namespace)`
            }
        } catch (err) {
            return {
                ok: false,
                message: `api call failed: ${sanitize((err as Error).message)}`
            }
        }
    }

    private async resolveProvider(providerId: string): Promise<K8sClient> {
        const [row] = await this.db
            .select()
            .from(runtimeProviders)
            .where(
                and(
                    eq(runtimeProviders.id, providerId),
                    eq(runtimeProviders.kind, 'k8s')
                )
            )
            .limit(1)
        if (!row)
            throw new NotFoundException(
                `k8s runtime provider ${providerId} not found`
            )
        const version = row.updatedAt.toISOString()
        const cached = this.cache.get(providerId)
        if (cached && cached.version === version) return cached.client

        const yaml = this.crypto.decrypt({
            ciphertext: row.credentialCiphertext,
            keyVersion: row.credentialKeyVersion
        })
        const kc = new KubeConfig()
        try {
            kc.loadFromString(yaml)
        } catch (err) {
            throw new ServiceUnavailableException({
                message: `failed to load kubeconfig for k8s runtime provider ${row.name}`,
                reason: (err as Error).message
            })
        }
        const config = (row.config ?? {}) as { hostSuffix?: string | null }
        const client: K8sClient = {
            providerId,
            hostSuffix: config.hostSuffix ?? null,
            apis: buildApisFromKubeConfig(kc),
            kubeConfig: kc
        }
        this.cache.set(providerId, { version, client })
        return client
    }

    private async resolveDefaultClient(): Promise<K8sClient> {
        const [row] = await this.db
            .select({ id: runtimeProviders.id })
            .from(runtimeProviders)
            .where(
                and(
                    eq(runtimeProviders.kind, 'k8s'),
                    eq(runtimeProviders.status, 'enabled')
                )
            )
            .orderBy(desc(runtimeProviders.priority), asc(runtimeProviders.createdAt))
            .limit(1)
        if (row) return this.resolveProvider(row.id)
        return this.resolveEnvFallback()
    }

    private async resolveEnvFallback(): Promise<K8sClient> {
        if (!this.envKubeconfigPath)
            throw new ServiceUnavailableException({
                message: 'k8s runtime not configured',
                reason: 'no k8s runtime provider registered and KUBECONFIG env not set'
            })
        const cached = this.cache.get(ENV_CACHE_KEY)
        if (cached) return cached.client
        const kc = new KubeConfig()
        try {
            kc.loadFromFile(this.envKubeconfigPath)
        } catch (err) {
            throw new ServiceUnavailableException({
                message: 'k8s runtime not configured',
                reason: `kubeconfig load failed: ${(err as Error).message}`
            })
        }
        const client: K8sClient = {
            providerId: null,
            hostSuffix: null,
            apis: buildApisFromKubeConfig(kc),
            kubeConfig: kc
        }
        this.cache.set(ENV_CACHE_KEY, { version: 'env', client })
        return client
    }
}

const sanitize = (msg: string): string =>
    msg.slice(0, 256).replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
