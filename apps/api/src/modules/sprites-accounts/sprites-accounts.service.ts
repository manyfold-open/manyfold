import {
    SdkSpritesAccountSummary,
    createObjectId
} from '@manyfold/shared'
import {
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
    agents,
    spritesAccounts,
    type Database,
    type SpritesAccount
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'

interface VaultToken {
    orgSlug: string
    orgId: string
    tokenId: string
    fullToken: string
}

const parseVaultToken = (raw: string): VaultToken => {
    const fullToken = raw.trim()
    const parts = fullToken.split('/')
    if (parts.length !== 4)
        throw new Error(
            'Sprites token must be formatted "<orgSlug>/<orgId>/<tokenId>/<tokenValue>"'
        )
    const [orgSlug, orgId, tokenId, tokenValue] = parts
    if (!orgSlug || !orgId || !tokenId || !tokenValue)
        throw new Error('Sprites token has empty segment')
    return { orgSlug, orgId, tokenId, fullToken }
}

@Injectable()
export class SpritesAccountsService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    async add(input: {
        slug: string
        token: string
        notes?: string
        priority?: number
    }): Promise<SpritesAccount> {
        const parsed = parseVaultToken(input.token)
        const existing = await this.db
            .select()
            .from(spritesAccounts)
            .where(eq(spritesAccounts.slug, input.slug))
            .limit(1)
        if (existing[0])
            throw new ConflictException(
                `sprites account "${input.slug}" already exists`
            )
        const enc = this.crypto.encrypt(parsed.fullToken)
        const [row] = await this.db
            .insert(spritesAccounts)
            .values({
                id: createObjectId('spritesAccount'),
                slug: input.slug,
                orgSlug: parsed.orgSlug,
                orgId: parsed.orgId,
                tokenId: parsed.tokenId,
                tokenCiphertext: enc.ciphertext,
                tokenKeyVersion: enc.keyVersion,
                status: 'enabled',
                priority: input.priority ?? 0,
                notes: input.notes ?? null
            })
            .returning()
        return row
    }

    async rotate(slug: string, token: string): Promise<SpritesAccount> {
        const parsed = parseVaultToken(token)
        const enc = this.crypto.encrypt(parsed.fullToken)
        const [row] = await this.db
            .update(spritesAccounts)
            .set({
                orgSlug: parsed.orgSlug,
                orgId: parsed.orgId,
                tokenId: parsed.tokenId,
                tokenCiphertext: enc.ciphertext,
                tokenKeyVersion: enc.keyVersion,
                updatedAt: new Date()
            })
            .where(eq(spritesAccounts.slug, slug))
            .returning()
        if (!row) throw new NotFoundException(`sprites account "${slug}"`)
        return row
    }

    async setStatus(
        slug: string,
        status: 'enabled' | 'disabled'
    ): Promise<SpritesAccount> {
        const [row] = await this.db
            .update(spritesAccounts)
            .set({ status, updatedAt: new Date() })
            .where(eq(spritesAccounts.slug, slug))
            .returning()
        if (!row) throw new NotFoundException(`sprites account "${slug}"`)
        return row
    }

    async updateNotes(
        slug: string,
        notes: string | null
    ): Promise<SpritesAccount> {
        const [row] = await this.db
            .update(spritesAccounts)
            .set({ notes, updatedAt: new Date() })
            .where(eq(spritesAccounts.slug, slug))
            .returning()
        if (!row) throw new NotFoundException(`sprites account "${slug}"`)
        return row
    }

    async patch(
        slug: string,
        patch: { notes?: string | null; priority?: number }
    ): Promise<SpritesAccount> {
        const updates: Partial<SpritesAccount> = { updatedAt: new Date() }
        if (patch.notes !== undefined) updates.notes = patch.notes
        if (patch.priority !== undefined) updates.priority = patch.priority
        const [row] = await this.db
            .update(spritesAccounts)
            .set(updates)
            .where(eq(spritesAccounts.slug, slug))
            .returning()
        if (!row) throw new NotFoundException(`sprites account "${slug}"`)
        return row
    }

    async getSummary(slug: string): Promise<SdkSpritesAccountSummary> {
        const [row] = await this.db
            .select()
            .from(spritesAccounts)
            .where(eq(spritesAccounts.slug, slug))
            .limit(1)
        if (!row) throw new NotFoundException(`sprites account "${slug}"`)
        const [count] = await this.db
            .select({ n: sql<number>`count(*)::int` })
            .from(agents)
            .where(
                and(
                    eq(agents.accountId, row.id),
                    inArray(agents.status, ['pending', 'running'])
                )
            )
        return {
            id: row.id,
            slug: row.slug,
            orgSlug: row.orgSlug,
            status: row.status,
            priority: row.priority,
            notes: row.notes,
            activeSprites: Number(count?.n ?? 0),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    async list(): Promise<SdkSpritesAccountSummary[]> {
        const rows = await this.db
            .select()
            .from(spritesAccounts)
            .orderBy(
                desc(spritesAccounts.priority),
                asc(spritesAccounts.createdAt)
            )
        if (rows.length === 0) return []
        const accountIds = rows.map((r) => r.id)
        const counts = await this.db
            .select({
                accountId: agents.accountId,
                n: sql<number>`count(*)::int`
            })
            .from(agents)
            .where(
                and(
                    inArray(agents.accountId, accountIds),
                    inArray(agents.status, ['pending', 'running'])
                )
            )
            .groupBy(agents.accountId)
        const countMap = new Map<string, number>()
        for (const c of counts)
            if (c.accountId) countMap.set(c.accountId, Number(c.n))
        return rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            orgSlug: r.orgSlug,
            status: r.status,
            priority: r.priority,
            notes: r.notes,
            activeSprites: countMap.get(r.id) ?? 0,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString()
        }))
    }

    async selectForCreate(input: {
        accountId?: string
        callerIsAdmin: boolean
    }): Promise<SpritesAccount> {
        if (input.accountId) {
            if (!input.callerIsAdmin)
                throw new ForbiddenException(
                    'Only admins may pin a sprites account via accountId'
                )
            const [row] = await this.db
                .select()
                .from(spritesAccounts)
                .where(eq(spritesAccounts.id, input.accountId))
                .limit(1)
            if (!row)
                throw new NotFoundException(
                    `sprites account ${input.accountId}`
                )
            if (row.status !== 'enabled')
                throw new ServiceUnavailableException(
                    `sprites account ${row.slug} is disabled`
                )
            return row
        }
        const candidates = await this.db
            .select({
                id: spritesAccounts.id,
                slug: spritesAccounts.slug,
                orgSlug: spritesAccounts.orgSlug,
                orgId: spritesAccounts.orgId,
                tokenId: spritesAccounts.tokenId,
                tokenCiphertext: spritesAccounts.tokenCiphertext,
                tokenKeyVersion: spritesAccounts.tokenKeyVersion,
                status: spritesAccounts.status,
                priority: spritesAccounts.priority,
                notes: spritesAccounts.notes,
                createdAt: spritesAccounts.createdAt,
                updatedAt: spritesAccounts.updatedAt,
                active: sql<number>`count(${agents.id}) filter (where ${agents.status} in ('pending','running'))::int`
            })
            .from(spritesAccounts)
            .leftJoin(agents, eq(agents.accountId, spritesAccounts.id))
            .where(eq(spritesAccounts.status, 'enabled'))
            .groupBy(spritesAccounts.id)
            .orderBy(
                desc(spritesAccounts.priority),
                sql`count(${agents.id}) filter (where ${agents.status} in ('pending','running')) asc`,
                spritesAccounts.createdAt
            )
            .limit(1)
        const picked = candidates[0]
        if (!picked)
            throw new ServiceUnavailableException(
                'No enabled sprites accounts available'
            )
        return {
            id: picked.id,
            slug: picked.slug,
            orgSlug: picked.orgSlug,
            orgId: picked.orgId,
            tokenId: picked.tokenId,
            tokenCiphertext: picked.tokenCiphertext,
            tokenKeyVersion: picked.tokenKeyVersion,
            status: picked.status,
            priority: picked.priority,
            notes: picked.notes,
            createdAt: picked.createdAt,
            updatedAt: picked.updatedAt
        }
    }

    async getById(accountId: string): Promise<SpritesAccount | null> {
        const [row] = await this.db
            .select()
            .from(spritesAccounts)
            .where(eq(spritesAccounts.id, accountId))
            .limit(1)
        return row ?? null
    }

    decryptToken(account: SpritesAccount): string {
        return this.crypto.decrypt({
            ciphertext: account.tokenCiphertext,
            keyVersion: account.tokenKeyVersion
        })
    }
}
