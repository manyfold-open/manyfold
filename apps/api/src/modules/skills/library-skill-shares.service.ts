import {
    GetLibrarySkillShareResult,
    ShareLibrarySkillResult,
    SharedSkillPreview,
    createObjectId,
    isObjectId
} from '@manyfold/shared'
import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import {
    librarySkillFiles,
    librarySkills,
    librarySkillShares,
    users,
    type Database,
    type LibrarySkillRow,
    type LibrarySkillShareRow
} from '@manyfold/db'
import { configString } from '@/common/config-alias'
import { DRIZZLE } from '@/db/tokens'

@Injectable()
export class LibrarySkillSharesService {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly config: ConfigService
    ) {}

    async createShare(
        userId: string,
        librarySkillId: string
    ): Promise<ShareLibrarySkillResult> {
        await this.assertOwned(userId, librarySkillId)
        const active = await this.activeForSkill(librarySkillId)
        if (active) return this.toShareResult(active)
        try {
            const [row] = await this.db
                .insert(librarySkillShares)
                .values({
                    id: createObjectId('librarySkillShare'),
                    librarySkillId,
                    userId
                })
                .returning()
            return this.toShareResult(row)
        } catch (err) {
            if (isActiveShareConflict(err)) {
                const existing = await this.activeForSkill(librarySkillId)
                if (existing) return this.toShareResult(existing)
            }
            throw err
        }
    }

    async revokeShare(userId: string, librarySkillId: string): Promise<void> {
        await this.assertOwned(userId, librarySkillId)
        await this.db
            .update(librarySkillShares)
            .set({ revokedAt: new Date(), updatedAt: new Date() })
            .where(
                and(
                    eq(librarySkillShares.librarySkillId, librarySkillId),
                    isNull(librarySkillShares.revokedAt)
                )
            )
    }

    async getShare(
        userId: string,
        librarySkillId: string
    ): Promise<GetLibrarySkillShareResult> {
        await this.assertOwned(userId, librarySkillId)
        const active = await this.activeForSkill(librarySkillId)
        return { share: active ? this.toShareResult(active) : null }
    }

    // Missing, revoked, malformed and cascade-deleted shares all resolve to
    // null so both public preview and import share one uniform 404.
    async resolveActiveShare(shareId: string): Promise<{
        share: LibrarySkillShareRow
        skill: LibrarySkillRow
    } | null> {
        if (!isObjectId(shareId, 'librarySkillShare')) return null
        const [row] = await this.db
            .select({ share: librarySkillShares, skill: librarySkills })
            .from(librarySkillShares)
            .innerJoin(
                librarySkills,
                eq(librarySkillShares.librarySkillId, librarySkills.id)
            )
            .where(
                and(
                    eq(librarySkillShares.id, shareId),
                    isNull(librarySkillShares.revokedAt)
                )
            )
            .limit(1)
        return row ?? null
    }

    // Built field-by-field on purpose: LibrarySkillDetail carries the owner's
    // internal ids, origin (may embed a private GitHub URL) and contentHash,
    // none of which belong on an unauthenticated surface.
    async buildPublicPreview(shareId: string): Promise<SharedSkillPreview> {
        const resolved = await this.resolveActiveShare(shareId)
        if (!resolved) throw shareNotFound()
        const files = await this.db
            .select({ path: librarySkillFiles.path })
            .from(librarySkillFiles)
            .where(eq(librarySkillFiles.librarySkillId, resolved.skill.id))
            .orderBy(asc(librarySkillFiles.path))
        const [owner] = await this.db
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, resolved.share.userId))
            .limit(1)
        return {
            skill: {
                name: resolved.skill.name,
                description: resolved.skill.description,
                content: resolved.skill.content,
                files: files.map((file) => ({ path: file.path })),
                updatedAt: resolved.skill.updatedAt.toISOString()
            },
            sharedBy: owner?.displayName ?? null
        }
    }

    async recordImport(shareId: string): Promise<void> {
        await this.db
            .update(librarySkillShares)
            .set({
                importCount: sql`${librarySkillShares.importCount} + 1`,
                updatedAt: new Date()
            })
            .where(eq(librarySkillShares.id, shareId))
    }

    private async assertOwned(userId: string, id: string): Promise<void> {
        const [row] = await this.db
            .select({ id: librarySkills.id })
            .from(librarySkills)
            .where(
                and(eq(librarySkills.id, id), eq(librarySkills.userId, userId))
            )
            .limit(1)
        if (!row) throw new NotFoundException(`library skill ${id}`)
    }

    private async activeForSkill(
        librarySkillId: string
    ): Promise<LibrarySkillShareRow | null> {
        const [row] = await this.db
            .select()
            .from(librarySkillShares)
            .where(
                and(
                    eq(librarySkillShares.librarySkillId, librarySkillId),
                    isNull(librarySkillShares.revokedAt)
                )
            )
            .limit(1)
        return row ?? null
    }

    private toShareResult(row: LibrarySkillShareRow): ShareLibrarySkillResult {
        return {
            id: row.id,
            librarySkillId: row.librarySkillId,
            url: `${this.webUrl()}/skills/shared/${row.id}`,
            importCount: row.importCount,
            createdAt: row.createdAt.toISOString()
        }
    }

    private webUrl(): string {
        const raw =
            configString(this.config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? 'https://manyfold.ai'
        return raw.replace(/\/+$/, '')
    }
}

export const shareNotFound = (): NotFoundException =>
    new NotFoundException({
        code: 'skill_share_not_found',
        message: 'share not found'
    })

const isActiveShareConflict = (err: unknown): boolean =>
    err instanceof Error &&
    err.message.includes('library_skill_shares_active_skill_uq')
