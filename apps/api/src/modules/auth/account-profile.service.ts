import type { AccountProfileSummary } from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    PayloadTooLargeException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    userAvatars,
    users,
    type Database,
    type UserAvatar
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { DISPLAY_NAME_MAX, cleanDisplayName } from './linked-identities'

export const AVATAR_MAX_BYTES = 512 * 1024

// Sniffed, not trusted: the uploaded content-type is attacker-controlled, so
// the stored type is derived from the file's magic bytes.
const sniffImageType = (bytes: Buffer): string | null => {
    if (
        bytes.length >= 4 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
    )
        return 'image/png'
    if (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
    )
        return 'image/jpeg'
    if (
        bytes.length >= 12 &&
        bytes.toString('latin1', 0, 4) === 'RIFF' &&
        bytes.toString('latin1', 8, 12) === 'WEBP'
    )
        return 'image/webp'
    return null
}

@Injectable()
export class AccountProfileService {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async getSummary(userId: string): Promise<AccountProfileSummary> {
        const [row] = await this.db
            .select({ displayName: users.displayName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
        const [avatar] = await this.db
            .select({ updatedAt: userAvatars.updatedAt })
            .from(userAvatars)
            .where(eq(userAvatars.userId, userId))
            .limit(1)
        return {
            displayName: row?.displayName ?? null,
            avatarUpdatedAt: avatar?.updatedAt.toISOString() ?? null
        }
    }

    async updateDisplayName(
        userId: string,
        raw: string | null | undefined
    ): Promise<AccountProfileSummary> {
        const displayName = this.normalizeDisplayName(raw)
        await this.db
            .update(users)
            .set({ displayName, updatedAt: new Date() })
            .where(eq(users.id, userId))
        return this.getSummary(userId)
    }

    async setAvatar(
        userId: string,
        bytes: Buffer
    ): Promise<AccountProfileSummary> {
        if (bytes.length > AVATAR_MAX_BYTES)
            throw new PayloadTooLargeException({
                code: 'profile.avatar_too_large',
                message: 'the image must be at most 512KB'
            })
        const contentType = sniffImageType(bytes)
        if (!contentType)
            throw new BadRequestException({
                code: 'profile.avatar_invalid',
                message: 'the file must be a PNG, JPEG or WebP image'
            })
        await this.db
            .insert(userAvatars)
            .values({ userId, contentType, bytes, updatedAt: new Date() })
            .onConflictDoUpdate({
                target: userAvatars.userId,
                set: { contentType, bytes, updatedAt: new Date() }
            })
        return this.getSummary(userId)
    }

    async removeAvatar(userId: string): Promise<void> {
        await this.db
            .delete(userAvatars)
            .where(eq(userAvatars.userId, userId))
    }

    async getAvatar(userId: string): Promise<UserAvatar | null> {
        const [row] = await this.db
            .select()
            .from(userAvatars)
            .where(eq(userAvatars.userId, userId))
            .limit(1)
        return row ?? null
    }

    private normalizeDisplayName(
        raw: string | null | undefined
    ): string | null {
        const collapsed = cleanDisplayName(raw)
        if (!collapsed) return null
        if ([...collapsed].length > DISPLAY_NAME_MAX)
            throw new BadRequestException({
                code: 'profile.display_name_too_long',
                message: `the name must be at most ${DISPLAY_NAME_MAX} characters`
            })
        return collapsed
    }
}
