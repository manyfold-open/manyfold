import {
    createObjectId,
    type CreateRuntimeProviderBody,
    type RuntimeProviderProbeResult,
    type RuntimeProviderSummary,
    type UpdateRuntimeProviderBody
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException
} from '@nestjs/common'
import { and, asc, count, desc, eq, ne } from 'drizzle-orm'
import {
    runtimeHosts,
    runtimeProviders,
    type Database,
    type K8sProviderConfig,
    type RuntimeProvider,
    type RuntimeProviderConfig,
    type SpritesProviderConfig
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { HostProviderClients } from '@/modules/hosts/providers/host-provider-clients.service'

interface SpritesVaultToken {
    orgSlug: string
    orgId: string
    tokenId: string
    fullToken: string
}

// A sprites.dev credential is `<orgSlug>/<orgId>/<tokenId>/<tokenValue>`; the
// three ids are the non-secret half and go into `config`, the whole string is
// the API token and goes into the envelope.
export const parseSpritesVaultToken = (raw: string): SpritesVaultToken => {
    const fullToken = raw.trim()
    const parts = fullToken.split('/')
    if (parts.length !== 4)
        throw new BadRequestException(
            'Sprites credential must be formatted "<orgSlug>/<orgId>/<tokenId>/<tokenValue>"'
        )
    const [orgSlug, orgId, tokenId, tokenValue] = parts
    if (!orgSlug || !orgId || !tokenId || !tokenValue)
        throw new BadRequestException('Sprites credential has an empty segment')
    return { orgSlug, orgId, tokenId, fullToken }
}

const isUniqueViolation = (err: unknown): boolean =>
    (err as { code?: string })?.code === '23505' ||
    (err as { cause?: { code?: string } })?.cause?.code === '23505'

const optionalString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

// Admin management of the platform's hosted capacity (ADR-0036): one row per
// sprites organisation or Kubernetes cluster. The shared columns are the
// core's; what `config` holds and how a credential is probed is per kind.
@Injectable()
export class RuntimeProvidersAdminService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly k8s: KubernetesService,
        private readonly clients: HostProviderClients
    ) {}

    async list(): Promise<RuntimeProviderSummary[]> {
        const rows = await this.db
            .select({ provider: runtimeProviders, hostCount: count(runtimeHosts.id) })
            .from(runtimeProviders)
            .leftJoin(
                runtimeHosts,
                and(
                    eq(runtimeHosts.providerId, runtimeProviders.id),
                    ne(runtimeHosts.status, 'retired')
                )
            )
            .groupBy(runtimeProviders.id)
            .orderBy(
                asc(runtimeProviders.kind),
                desc(runtimeProviders.priority),
                asc(runtimeProviders.createdAt)
            )
        return rows.map((r) => toSummary(r.provider, Number(r.hostCount)))
    }

    async get(id: string): Promise<RuntimeProviderSummary> {
        const row = await this.findOrThrow(id)
        return toSummary(row, await this.hostCount(id))
    }

    async create(body: CreateRuntimeProviderBody): Promise<RuntimeProviderSummary> {
        const prepared = await this.prepareCredential(
            body.kind,
            body.credential,
            body.config ?? {}
        )
        const enc = this.crypto.encrypt(prepared.secret)
        const now = new Date()
        try {
            const [row] = await this.db
                .insert(runtimeProviders)
                .values({
                    id: createObjectId('runtimeProvider'),
                    kind: body.kind,
                    name: body.name.trim(),
                    status: 'enabled',
                    priority: body.priority ?? 0,
                    region: optionalString(body.region),
                    credentialCiphertext: enc.ciphertext,
                    credentialKeyVersion: enc.keyVersion,
                    config: prepared.config,
                    lastHealthStatus: prepared.health.ok ? 'ok' : 'failed',
                    lastHealthMessage: prepared.health.message,
                    lastHealthCheckedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .returning()
            return toSummary(row, 0)
        } catch (err) {
            if (isUniqueViolation(err))
                throw new ConflictException(
                    `${body.kind} runtime provider "${body.name}" already exists`
                )
            throw err
        }
    }

    async update(
        id: string,
        body: UpdateRuntimeProviderBody
    ): Promise<RuntimeProviderSummary> {
        const existing = await this.findOrThrow(id)
        const updates: Partial<RuntimeProvider> = { updatedAt: new Date() }
        if (body.name !== undefined) updates.name = body.name.trim()
        if (body.status !== undefined) updates.status = body.status
        if (body.priority !== undefined) updates.priority = body.priority
        if (body.region !== undefined) updates.region = optionalString(body.region)
        if (body.credential !== undefined) {
            const prepared = await this.prepareCredential(
                existing.kind,
                body.credential,
                { ...existing.config, ...(body.config ?? {}) }
            )
            const enc = this.crypto.encrypt(prepared.secret)
            updates.credentialCiphertext = enc.ciphertext
            updates.credentialKeyVersion = enc.keyVersion
            updates.config = prepared.config
            updates.lastHealthStatus = prepared.health.ok ? 'ok' : 'failed'
            updates.lastHealthMessage = prepared.health.message
            updates.lastHealthCheckedAt = new Date()
        } else if (body.config !== undefined) {
            updates.config = this.mergeConfig(existing, body.config)
        }
        try {
            const [row] = await this.db
                .update(runtimeProviders)
                .set(updates)
                .where(eq(runtimeProviders.id, id))
                .returning()
            this.invalidate(row)
            return toSummary(row, await this.hostCount(id))
        } catch (err) {
            if (isUniqueViolation(err))
                throw new ConflictException(
                    `${existing.kind} runtime provider "${updates.name}" already exists`
                )
            throw err
        }
    }

    // RESTRICT on runtime_hosts.provider_id: a provider that still owns
    // machines cannot go, and the user gets told how many.
    async remove(id: string): Promise<void> {
        await this.findOrThrow(id)
        const n = await this.hostCount(id, true)
        if (n > 0)
            throw new ConflictException({
                message: `runtime provider still hosts ${n} machine(s)`,
                code: 'RUNTIME_PROVIDER_IN_USE',
                count: n
            })
        const [deleted] = await this.db
            .delete(runtimeProviders)
            .where(eq(runtimeProviders.id, id))
            .returning()
        if (deleted) this.invalidate(deleted)
    }

    async probe(id: string): Promise<RuntimeProviderProbeResult> {
        const row = await this.findOrThrow(id)
        const result = await this.probeProvider(row)
        const now = new Date()
        await this.db
            .update(runtimeProviders)
            .set({
                lastHealthStatus: result.ok ? 'ok' : 'failed',
                lastHealthMessage: result.message,
                lastHealthCheckedAt: now,
                updatedAt: now
            })
            .where(eq(runtimeProviders.id, id))
        return { ok: result.ok, message: result.message, checkedAt: now.toISOString() }
    }

    private async probeProvider(
        row: RuntimeProvider
    ): Promise<{ ok: boolean; message: string }> {
        if (row.kind === 'k8s')
            return this.k8s.probeKubeconfig(this.clients.credentialFor(row))
        try {
            const client = this.clients.spritesClientForProvider(row)
            const sprites = await client.listSprites()
            const n = sprites.sprites?.length ?? 0
            return { ok: true, message: `reachable (listed ${n} sprite${n === 1 ? '' : 's'})` }
        } catch (err) {
            return {
                ok: false,
                message: `api call failed: ${(err as Error).message.slice(0, 256)}`
            }
        }
    }

    // What of the request becomes the secret and what becomes config, and
    // whether the secret works at all.
    private async prepareCredential(
        kind: RuntimeProvider['kind'],
        credential: string,
        config: Record<string, unknown>
    ): Promise<{
        secret: string
        config: RuntimeProviderConfig
        health: { ok: boolean; message: string }
    }> {
        if (kind === 'sprites') {
            const parsed = parseSpritesVaultToken(credential)
            const spritesConfig: SpritesProviderConfig = {
                orgSlug: parsed.orgSlug,
                orgId: parsed.orgId,
                tokenId: parsed.tokenId,
                notes: optionalString(config.notes)
            }
            return {
                secret: parsed.fullToken,
                config: spritesConfig,
                health: { ok: true, message: 'credential accepted' }
            }
        }
        const health = await this.k8s.probeKubeconfig(credential)
        const k8sConfig: K8sProviderConfig = {
            description: optionalString(config.description),
            hostSuffix: optionalString(config.hostSuffix)
        }
        return { secret: credential, config: k8sConfig, health }
    }

    private mergeConfig(
        existing: RuntimeProvider,
        patch: Record<string, unknown>
    ): RuntimeProviderConfig {
        if (existing.kind === 'sprites') {
            const current = existing.config as SpritesProviderConfig
            return {
                ...current,
                notes:
                    patch.notes === undefined
                        ? (current.notes ?? null)
                        : optionalString(patch.notes)
            }
        }
        const current = existing.config as K8sProviderConfig
        return {
            description:
                patch.description === undefined
                    ? (current.description ?? null)
                    : optionalString(patch.description),
            hostSuffix:
                patch.hostSuffix === undefined
                    ? (current.hostSuffix ?? null)
                    : optionalString(patch.hostSuffix)
        }
    }

    private invalidate(row: RuntimeProvider): void {
        this.clients.invalidateProvider(row.id)
        if (row.kind === 'k8s') this.k8s.invalidate(row.id)
    }

    private async hostCount(id: string, includeRetired = false): Promise<number> {
        const [row] = await this.db
            .select({ n: count() })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.providerId, id),
                    includeRetired ? undefined : ne(runtimeHosts.status, 'retired')
                )
            )
        return Number(row?.n ?? 0)
    }

    private async findOrThrow(id: string): Promise<RuntimeProvider> {
        const [row] = await this.db
            .select()
            .from(runtimeProviders)
            .where(eq(runtimeProviders.id, id))
            .limit(1)
        if (!row) throw new NotFoundException(`runtime provider ${id} not found`)
        return row
    }
}

const toSummary = (
    row: RuntimeProvider,
    hostCount: number
): RuntimeProviderSummary => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    priority: row.priority,
    region: row.region,
    config: (row.config ?? {}) as Record<string, unknown>,
    lastHealthStatus: row.lastHealthStatus,
    lastHealthMessage: row.lastHealthMessage,
    lastHealthCheckedAt: row.lastHealthCheckedAt?.toISOString() ?? null,
    hostCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})
