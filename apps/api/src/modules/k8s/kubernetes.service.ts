import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { asc, desc, eq } from 'drizzle-orm'
import {
    AppsV1Api,
    CoreV1Api,
    KubeConfig,
    NetworkingV1Api,
    ApiException
} from '@kubernetes/client-node'
import { k8sClusters, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'

const NAMESPACE_PREFIX = 'nca-user-'
const ENV_CACHE_KEY = '__env__'

export interface K8sApis {
    core: CoreV1Api
    apps: AppsV1Api
    networking: NetworkingV1Api
}

export interface K8sClient {
    clusterId: string | null
    hostSuffix: string | null
    apis: K8sApis
    kubeConfig: KubeConfig
}

interface CachedClient {
    version: string
    client: K8sClient
}

export const isApiNotFound = (err: unknown): boolean =>
    err instanceof ApiException && err.code === 404

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
                'KUBECONFIG env not set; k8s runtime requires a registered cluster'
            )
    }

    async getClient(clusterId: string | null): Promise<K8sClient> {
        if (clusterId) return this.resolveDbCluster(clusterId)
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
            if (err instanceof ApiException && err.code === 409) return name
            throw err
        }
        return name
    }

    invalidate(clusterId: string): void {
        this.cache.delete(clusterId)
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

    private async resolveDbCluster(clusterId: string): Promise<K8sClient> {
        const [row] = await this.db
            .select()
            .from(k8sClusters)
            .where(eq(k8sClusters.id, clusterId))
            .limit(1)
        if (!row)
            throw new NotFoundException(`k8s cluster ${clusterId} not found`)
        const version = row.updatedAt.toISOString()
        const cached = this.cache.get(clusterId)
        if (cached && cached.version === version) return cached.client

        const yaml = this.crypto.decrypt({
            ciphertext: row.kubeconfigCiphertext,
            keyVersion: row.kubeconfigKeyVersion
        })
        const kc = new KubeConfig()
        try {
            kc.loadFromString(yaml)
        } catch (err) {
            throw new ServiceUnavailableException({
                message: `failed to load kubeconfig for cluster ${row.name}`,
                reason: (err as Error).message
            })
        }
        const client: K8sClient = {
            clusterId,
            hostSuffix: row.hostSuffix,
            apis: buildApisFromKubeConfig(kc),
            kubeConfig: kc
        }
        this.cache.set(clusterId, { version, client })
        return client
    }

    private async resolveDefaultClient(): Promise<K8sClient> {
        const [row] = await this.db
            .select({ id: k8sClusters.id })
            .from(k8sClusters)
            .orderBy(desc(k8sClusters.priority), asc(k8sClusters.createdAt))
            .limit(1)
        if (row) return this.resolveDbCluster(row.id)
        return this.resolveEnvFallback()
    }

    private async resolveEnvFallback(): Promise<K8sClient> {
        if (!this.envKubeconfigPath)
            throw new ServiceUnavailableException({
                message: 'k8s runtime not configured',
                reason: 'no cluster selected and KUBECONFIG env not set'
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
            clusterId: null,
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
