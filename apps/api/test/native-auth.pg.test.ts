import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { after, before } from 'node:test'
import { eq } from 'drizzle-orm'
import { createDb, userSessions, users, type Database } from '@manyfold/db'
import type { ConfigService } from '@nestjs/config'
import type { ModuleRef } from '@nestjs/core'
import {
    SessionService,
    hashSessionToken,
    isSessionToken
} from '../src/modules/auth/session.service'
import { PasswordService } from '../src/modules/auth/password.service'
import { EmailVerificationService } from '../src/modules/auth/email-verification.service'
import { AuthService } from '../src/modules/auth/auth.service'
import type { AuthSettingsService } from '../src/modules/auth/auth-settings.service'
import type { EmailService } from '../src/modules/email/email.service'
import { noManagedModelsPort } from '@/common/ports/managed-models.ports'

// Real-Postgres proof of the native-auth security invariants. The fake-Drizzle
// harness can't exercise the actual `where`/`returning` semantics these depend
// on (single-use consume, hash-only persistence), so this runs against a
// migrated DB, env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    userId: string
    email: string
    sessions: SessionService
    passwords: PasswordService
    emailVerification: EmailVerificationService
    auth: AuthService
    sent: Array<{ to: string; text: string }>
}

let h: Harness

before(async () => {
    if (!RUN) return
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_natauth_${suffix}`
    const email = `${suffix}@natauth.local`
    await db.insert(users).values({ id: userId, email })

    const sent: Array<{ to: string; text: string }> = []
    const email_ = {
        send: async (m: { to: string; text: string }) => {
            sent.push(m)
        }
    } as unknown as EmailService
    const config = { get: () => undefined } as unknown as ConfigService
    const moduleRef = {
        get: () => {
            throw new Error('no module in test')
        }
    } as unknown as ModuleRef
    const authSettings = {
        getInitialAdminEmails: async () => new Set<string>()
    } as unknown as AuthSettingsService

    h = {
        db,
        userId,
        email,
        sent,
        sessions: new SessionService(db),
        passwords: new PasswordService(db),
        emailVerification: new EmailVerificationService(db, email_, config),
        auth: new AuthService(
            db,
            config,
            moduleRef,
            authSettings,
            { onUserProvisioned: async () => undefined } as never,
            noManagedModelsPort
        )
    }
})

after(async () => {
    if (!RUN || !h) return
    // Cascade clears sessions/passwords/identities/verifications.
    await h.db.delete(users).where(eq(users.id, h.userId))
    const client = (
        h.db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
})

test(
    'a session persists only the token hash, never the plaintext, and resolves it back',
    { skip: !RUN },
    async () => {
        const { token } = await h.sessions.mint({
            userId: h.userId,
            provider: 'email',
            subject: h.email
        })
        assert.ok(isSessionToken(token), 'token carries the mfs_ prefix')
        assert.ok(
            !token.startsWith('nca_'),
            'session token is not an api token'
        )
        const [row] = await h.db
            .select()
            .from(userSessions)
            .where(eq(userSessions.tokenHash, hashSessionToken(token)))
        assert.ok(row, 'row is stored under the hash')
        assert.notEqual(row.tokenHash, token)
        const principal = await h.sessions.verify(token)
        assert.equal(principal?.userId, h.userId)
        assert.equal(principal?.kind, 'human-session')
    }
)

test(
    'expired and revoked sessions both fail verification',
    { skip: !RUN },
    async () => {
        const expired = await h.sessions.mint({
            userId: h.userId,
            provider: 'email',
            subject: h.email
        })
        await h.db
            .update(userSessions)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(userSessions.tokenHash, hashSessionToken(expired.token)))
        assert.equal(await h.sessions.verify(expired.token), null)

        const live = await h.sessions.mint({
            userId: h.userId,
            provider: 'email',
            subject: h.email
        })
        await h.sessions.revoke(live.token)
        assert.equal(await h.sessions.verify(live.token), null)
    }
)

test(
    'verifying a live session slides its expiry forward so active use never forces a monthly re-login',
    { skip: !RUN },
    async () => {
        const { token } = await h.sessions.mint({
            userId: h.userId,
            provider: 'email',
            subject: h.email
        })
        // Wind the stored expiry back to a near-term deadline, as if the
        // session were minted weeks ago and is about to lapse.
        const soon = new Date(Date.now() + 86_400_000)
        await h.db
            .update(userSessions)
            .set({ expiresAt: soon })
            .where(eq(userSessions.tokenHash, hashSessionToken(token)))

        const principal = await h.sessions.verify(token)
        assert.equal(principal?.userId, h.userId)

        const [row] = await h.db
            .select()
            .from(userSessions)
            .where(eq(userSessions.tokenHash, hashSessionToken(token)))
        // The window jumped from ~1 day to ~30 days out: a used session keeps
        // renewing instead of dying on a fixed absolute deadline. The old code
        // only stamped lastUsedAt, leaving expiresAt frozen at `soon`.
        assert.ok(
            row.expiresAt.getTime() - soon.getTime() > 25 * 86_400_000,
            'expiry slid forward by roughly the full TTL on use'
        )
        assert.ok(row.lastUsedAt, 'lastUsedAt is stamped on verify')
    }
)

test(
    'password verify: correct true, wrong false, and a user with no row is false (no enumeration)',
    { skip: !RUN },
    async () => {
        await h.passwords.set(h.userId, 'correct horse battery staple')
        assert.equal(
            await h.passwords.verify(h.userId, 'correct horse battery staple'),
            true
        )
        assert.equal(
            await h.passwords.verify(h.userId, 'wrong password'),
            false
        )
        assert.equal(
            await h.passwords.verify(`user_missing_${h.userId}`, 'whatever'),
            false
        )
    }
)

test(
    'a verification code supersedes prior codes and can be redeemed exactly once',
    { skip: !RUN },
    async () => {
        await h.emailVerification.issue({
            userId: h.userId,
            email: h.email,
            purpose: 'email_verify'
        })
        const first = extractCode(h.sent.at(-1))
        await h.emailVerification.issue({
            userId: h.userId,
            email: h.email,
            purpose: 'email_verify'
        })
        const second = extractCode(h.sent.at(-1))
        assert.notEqual(first, undefined)
        assert.equal(
            await h.emailVerification.verify({
                email: h.email,
                code: first as string,
                purpose: 'email_verify'
            }),
            null,
            'the superseded code is dead'
        )
        assert.equal(
            await h.emailVerification.verify({
                email: h.email,
                code: second as string,
                purpose: 'email_verify'
            }),
            h.userId
        )
        assert.equal(
            await h.emailVerification.verify({
                email: h.email,
                code: second as string,
                purpose: 'email_verify'
            }),
            null,
            'single-use: a redeemed code cannot be replayed'
        )
    }
)

test(
    'too many wrong attempts locks the code even if the right one arrives later',
    { skip: !RUN },
    async () => {
        await h.emailVerification.issue({
            userId: h.userId,
            email: h.email,
            purpose: 'password_reset'
        })
        const code = extractCode(h.sent.at(-1)) as string
        const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0')
        for (let i = 0; i < 5; i += 1)
            assert.equal(
                await h.emailVerification.verify({
                    email: h.email,
                    code: wrong,
                    purpose: 'password_reset'
                }),
                null
            )
        assert.equal(
            await h.emailVerification.verify({
                email: h.email,
                code,
                purpose: 'password_reset'
            }),
            null,
            'attempt lock holds even for the correct code'
        )
    }
)

test(
    'accounts resolve by auth_identities(provider,subject), not by users.email',
    { skip: !RUN },
    async () => {
        await h.auth.linkIdentities(
            h.userId,
            [{ provider: 'email', subject: h.email, email: h.email }],
            h.email
        )
        assert.equal(
            await h.auth.findUserIdByIdentity('email', h.email),
            h.userId
        )
        assert.equal(
            await h.auth.findUserIdByIdentity('email', `other_${h.email}`),
            null
        )
    }
)

const extractCode = (
    message: { text: string } | undefined
): string | undefined => message?.text.match(/\b(\d{6})\b/)?.[1]
