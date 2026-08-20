import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { eq } from 'drizzle-orm'
import { userPasswords, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 256

@Injectable()
export class PasswordService {
    // A valid argon2id hash kept so verify() does comparable work when no
    // password row exists — login timing must not reveal whether an account has
    // a password (user-enumeration defense). Computed lazily, cached.
    private dummyHashPromise: Promise<string> | null = null

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    validatePolicy(plain: string): void {
        if (typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH)
            throw new BadRequestException({
                code: 'auth.weak_password',
                message: `password must be at least ${MIN_PASSWORD_LENGTH} characters`
            })
        if (plain.length > MAX_PASSWORD_LENGTH)
            throw new BadRequestException({
                code: 'auth.weak_password',
                message: `password must be at most ${MAX_PASSWORD_LENGTH} characters`
            })
    }

    async set(userId: string, plain: string): Promise<void> {
        await this.setHash(userId, await this.hash(plain))
    }

    // Hash without persisting, so a caller can write the hash inside its own
    // transaction (change-email sets the password atomically with the swap).
    hash(plain: string): Promise<string> {
        return argonHash(plain)
    }

    async setHash(userId: string, passwordHash: string): Promise<void> {
        await this.db
            .insert(userPasswords)
            .values({ userId, passwordHash })
            .onConflictDoUpdate({
                target: userPasswords.userId,
                set: { passwordHash, updatedAt: new Date() }
            })
    }

    async verify(userId: string, plain: string): Promise<boolean> {
        const [row] = await this.db
            .select({ passwordHash: userPasswords.passwordHash })
            .from(userPasswords)
            .where(eq(userPasswords.userId, userId))
            .limit(1)
        if (!row) {
            await argonVerify(await this.dummyHash(), plain).catch(() => false)
            return false
        }
        try {
            return await argonVerify(row.passwordHash, plain)
        } catch {
            return false
        }
    }

    async has(userId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ userId: userPasswords.userId })
            .from(userPasswords)
            .where(eq(userPasswords.userId, userId))
            .limit(1)
        return Boolean(row)
    }

    // When the password was last set. Change-email compares this to the
    // session's mint time: a password created mid-session is not re-auth
    // proof (a hijacked session could have set it moments ago).
    async lastChangedAt(userId: string): Promise<Date | null> {
        const [row] = await this.db
            .select({ updatedAt: userPasswords.updatedAt })
            .from(userPasswords)
            .where(eq(userPasswords.userId, userId))
            .limit(1)
        return row?.updatedAt ?? null
    }

    private dummyHash(): Promise<string> {
        if (!this.dummyHashPromise)
            this.dummyHashPromise = argonHash('manyfold-timing-defense')
        return this.dummyHashPromise
    }
}
