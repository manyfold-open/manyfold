import {
    K8sClusterProbeResult,
    K8sClusterSummary,
    createObjectId
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { asc, count, desc, eq } from 'drizzle-orm'
import { agents, k8sClusters, type Database, type K8sCluster } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { UpsertClusterDto } from '@/modules/clusters/dto/upsert-cluster.dto'

@Injectable()
export class ClustersService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly k8s: KubernetesService
    ) {}

    async list(): Promise<K8sClusterSummary[]> {
        const rows = await this.db
            .select()
            .from(k8sClusters)
            .orderBy(desc(k8sClusters.priority), asc(k8sClusters.createdAt))
        return rows.map(toSummary)
    }

    async get(id: string): Promise<K8sClusterSummary> {
        const row = await this.findOrThrow(id)
        return toSummary(row)
    }

    async create(dto: UpsertClusterDto): Promise<K8sClusterSummary> {
        if (!dto.kubeconfig)
            throw new BadRequestException('kubeconfig is required')
        await this.ensureNameUnique(dto.name)
        const probe = await this.k8s.probeKubeconfig(dto.kubeconfig)
        const enc = this.crypto.encrypt(dto.kubeconfig)
        const now = new Date()
        const id = createObjectId('k8sCluster')
        const [row] = await this.db
            .insert(k8sClusters)
            .values({
                id,
                name: dto.name,
                description: dto.description ?? null,
                hostSuffix: dto.hostSuffix || null,
                region: dto.region || null,
                kubeconfigCiphertext: enc.ciphertext,
                kubeconfigKeyVersion: enc.keyVersion,
                lastHealthStatus: probe.ok ? 'ok' : 'failed',
                lastHealthMessage: probe.message,
                lastHealthCheckedAt: now,
                priority: dto.priority ?? 0,
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return toSummary(row)
    }

    async update(
        id: string,
        dto: UpsertClusterDto
    ): Promise<K8sClusterSummary> {
        const existing = await this.findOrThrow(id)
        if (dto.name !== existing.name) await this.ensureNameUnique(dto.name)

        const updates: Partial<K8sCluster> = {
            name: dto.name,
            description: dto.description ?? null,
            hostSuffix: dto.hostSuffix || null,
            region: dto.region || null,
            updatedAt: new Date()
        }
        if (dto.priority !== undefined) updates.priority = dto.priority

        if (dto.kubeconfig) {
            const probe = await this.k8s.probeKubeconfig(dto.kubeconfig)
            const enc = this.crypto.encrypt(dto.kubeconfig)
            updates.kubeconfigCiphertext = enc.ciphertext
            updates.kubeconfigKeyVersion = enc.keyVersion
            updates.lastHealthStatus = probe.ok ? 'ok' : 'failed'
            updates.lastHealthMessage = probe.message
            updates.lastHealthCheckedAt = new Date()
        }

        const [row] = await this.db
            .update(k8sClusters)
            .set(updates)
            .where(eq(k8sClusters.id, id))
            .returning()
        this.k8s.invalidate(id)
        return toSummary(row)
    }

    async remove(id: string): Promise<void> {
        await this.findOrThrow(id)
        const [inUse] = await this.db
            .select({ n: count() })
            .from(agents)
            .where(eq(agents.clusterId, id))
        const n = Number(inUse?.n ?? 0)
        if (n > 0)
            throw new ConflictException({
                message: `cluster still in use by ${n} agent(s)`,
                code: 'K8S_CLUSTER_IN_USE',
                count: n
            })
        await this.db.delete(k8sClusters).where(eq(k8sClusters.id, id))
        this.k8s.invalidate(id)
    }

    async probe(id: string): Promise<K8sClusterProbeResult> {
        const row = await this.findOrThrow(id)
        const yaml = this.crypto.decrypt({
            ciphertext: row.kubeconfigCiphertext,
            keyVersion: row.kubeconfigKeyVersion
        })
        const result = await this.k8s.probeKubeconfig(yaml)
        const now = new Date()
        await this.db
            .update(k8sClusters)
            .set({
                lastHealthStatus: result.ok ? 'ok' : 'failed',
                lastHealthMessage: result.message,
                lastHealthCheckedAt: now,
                updatedAt: now
            })
            .where(eq(k8sClusters.id, id))
        return {
            ok: result.ok,
            message: result.message,
            checkedAt: now.toISOString()
        }
    }

    private async findOrThrow(id: string): Promise<K8sCluster> {
        const [row] = await this.db
            .select()
            .from(k8sClusters)
            .where(eq(k8sClusters.id, id))
            .limit(1)
        if (!row) throw new NotFoundException(`k8s cluster ${id} not found`)
        return row
    }

    private async ensureNameUnique(name: string): Promise<void> {
        const [row] = await this.db
            .select({ id: k8sClusters.id })
            .from(k8sClusters)
            .where(eq(k8sClusters.name, name))
            .limit(1)
        if (row) throw new ConflictException(`cluster "${name}" already exists`)
    }
}

const toSummary = (row: K8sCluster): K8sClusterSummary => ({
    id: row.id,
    name: row.name,
    description: row.description,
    hostSuffix: row.hostSuffix,
    region: row.region,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthMessage: row.lastHealthMessage,
    lastHealthCheckedAt: row.lastHealthCheckedAt?.toISOString() ?? null,
    priority: row.priority,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})
