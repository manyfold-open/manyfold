import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    authIdentities,
    createDb,
    userPasswords,
    users,
    type Database
} from '@manyfold/db'
import type { AuthPrincipal } from '../src/common/guards/auth.guard'
import { AccountEmailController } from '../src/modules/auth/account-email.controller'
import { AccountPasswordController } from '../src/modules/auth/account-password.controller'
import { AuthService } from '../src/modules/auth/auth.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import { EmailVerificationService } from '../src/modules/auth/email-verification.service'
import { PasswordService } from '../src/modules/auth/password.service'
import { SessionService } from '../src/modules/auth/session.service'
import { noManagedModelsPort } from '@/common/ports/managed-models.ports'

// Real-Postgres proof that a live session alone cannot mint a password. The
// first-password laundering chain (stolen session → set password → re-login
// → password predates the fresh session → passes change-email re-auth) must
// break at step one: PUT /me/password without the mailed setup code stores
// nothing. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'

interface SentMail {
    to: string
    subject: string
    text: string
    tag?: string
}

interface Harness {
    db: Database
    userId: string
    email: string
    suffix: string
    sent: SentMail[]
    passwords: PasswordService
    sessions: SessionService
    emailVerification: EmailVerificationService
    passwordController: AccountPasswordController
    emailController: AccountEmailController
    close: () => Promise<void>
}

const REQ = { headers: {}, ip: '127.0.0.1' } as never

const principalOn = (
    h: Pick<Harness, 'userId' | 'email'>,
    sessionCreatedAt: Date
): AuthPrincipal =>
    ({
        userId: h.userId,
        email: h.email,
        kind: 'human-session',
        provider: 'google',
        subject: 'pgtest',
        sessionCreatedAt
    }) as AuthPrincipal

// The last code the service mailed for a purpose — what the inbox owner (and
// only the inbox owner) can read.
const mailedCode = (sent: SentMail[], tag: string): string => {
    const mail = [...sent].reverse().find((m) => m.tag === tag)
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1]
    if (!code) throw new Error(`no ${tag} code mailed`)
    return code
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const email = `${suffix}@pgtest.local`
    await db.insert(users).values({ id: userId, email })
    // A Google-signup account: linked identities but no password row.
    await db.insert(authIdentities).values([
        { provider: 'google', subject: `sub_${suffix}`, userId, email },
        { provider: 'email', subject: email, userId, email }
    ])
    const sent: SentMail[] = []
    const emailService = {
        send: async (input: SentMail) => {
            sent.push(input)
        }
    } as never
    const auth = new AuthService(
        db,
        { get: () => '' } as never,
        { get: () => ({ process: async () => {} }) } as never,
        { getInitialAdminEmails: async () => new Set<string>() } as never,
        { onUserProvisioned: async () => undefined } as never,
        noManagedModelsPort
    )
    const authSettings = {
        getPrivateSettings: async () => ({ passwordEnabled: true })
    } as never
    const passwords = new PasswordService(db)
    const sessions = new SessionService(db)
    const emailVerification = new EmailVerificationService(
        db,
        emailService,
        { get: () => '' } as never
    )
    const rateLimit = new CliAuthRateLimitService()
    return {
        db,
        userId,
        email,
        suffix,
        sent,
        passwords,
        sessions,
        emailVerification,
        passwordController: new AccountPasswordController(
            auth,
            authSettings,
            passwords,
            sessions,
            emailVerification,
            emailService,
            rateLimit
        ),
        emailController: new AccountEmailController(
            auth,
            passwords,
            emailVerification,
            emailService,
            rateLimit
        ),
        close: async () => {
            await db.delete(users).where(eq(users.id, userId))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const passwordRows = async (h: Harness): Promise<number> => {
    const rows = await h.db
        .select({ userId: userPasswords.userId })
        .from(userPasswords)
        .where(eq(userPasswords.userId, h.userId))
    return rows.length
}

test('a session alone cannot mint a password usable as change-email re-auth', {
    skip: !RUN
}, async (t) => {
    const h = await buildHarness()
    t.after(h.close)
    const session = principalOn(h, new Date())

    // Step one of the takeover chain must fail: no code, no password row.
    await assert.rejects(
        () =>
            h.passwordController.setPassword(session, {
                password: 'attacker-password'
            }),
        /code_invalid|verification code/
    )
    assert.equal(await passwordRows(h), 0)

    // And so the chain's end stays closed: with nothing stored, the password
    // branch of change-email re-auth never opens.
    await assert.rejects(
        () =>
            h.emailController.start(
                session,
                {
                    newEmail: `attacker-${h.suffix}@pgtest.local`,
                    currentPassword: 'attacker-password'
                },
                REQ
            ),
        /reauth_required|re-authenticate/
    )
})

test('setup code proves the account inbox and completes the first set', {
    skip: !RUN
}, async (t) => {
    const h = await buildHarness()
    t.after(h.close)
    const sessionMintedAt = new Date()
    const session = principalOn(h, sessionMintedAt)

    // The code goes to the server-resolved sign-in address — the endpoint
    // takes no body, so a caller cannot point it anywhere else.
    await h.passwordController.setupStart(session, REQ)
    const setupMail = h.sent.find((m) => m.tag === 'auth.password_setup')
    assert.equal(setupMail?.to, h.email)

    const identities = await h.passwordController.setPassword(session, {
        password: 'owner-password',
        code: mailedCode(h.sent, 'auth.password_setup')
    })
    const emailIdentity = identities.find((i) => i.provider === 'email')
    assert.equal(emailIdentity?.hasPassword, true)
    assert.equal(await passwordRows(h), 1)
    assert.equal(await h.passwords.verify(h.userId, 'owner-password'), true)

    // Defense in depth stays intact: even a code-proven password set
    // mid-session is not re-auth proof until a fresh login.
    await assert.rejects(
        () =>
            h.emailController.start(
                session,
                {
                    newEmail: `next-${h.suffix}@pgtest.local`,
                    currentPassword: 'owner-password'
                },
                REQ
            ),
        /reauth_required|re-authenticate/
    )

    // After a re-login (session minted later than the password) the same
    // password is accepted — the legitimate path stays usable.
    const relogin = principalOn(h, new Date(Date.now() + 1000))
    await h.emailController.start(
        relogin,
        {
            newEmail: `next-${h.suffix}@pgtest.local`,
            currentPassword: 'owner-password'
        },
        REQ
    )
})

test('cross-purpose and cross-user setup codes are rejected', {
    skip: !RUN
}, async (t) => {
    const h = await buildHarness()
    const otherId = `user_pgtest_other_${h.suffix}`
    // Same address on another account (possible when the other account is
    // OAuth-only and never claimed the email identity).
    await h.db.insert(users).values({ id: otherId, email: h.email })
    // Single hook: extra rows must go BEFORE close() ends the pg pool.
    t.after(async () => {
        await h.db.delete(users).where(eq(users.id, otherId))
        await h.close()
    })
    const session = principalOn(h, new Date())

    // A password-reset code mailed to the same inbox is a different grant —
    // it must not double as first-password-setup proof.
    await h.emailVerification.issue({
        userId: h.userId,
        email: h.email,
        purpose: 'password_reset'
    })
    await assert.rejects(
        () =>
            h.passwordController.setPassword(session, {
                password: 'owner-password',
                code: mailedCode(h.sent, 'auth.password_reset')
            }),
        /code_invalid|verification code/
    )

    // A setup code minted for the OTHER user sharing the address must not
    // count for this one.
    await h.emailVerification.issue({
        userId: otherId,
        email: h.email,
        purpose: 'password_setup'
    })
    await assert.rejects(
        () =>
            h.passwordController.setPassword(session, {
                password: 'owner-password',
                code: mailedCode(h.sent, 'auth.password_setup')
            }),
        /code_invalid|verification code/
    )
    assert.equal(await passwordRows(h), 0)
})

test('setting a password evicts every other session but spares the caller', {
    skip: !RUN
}, async (t) => {
    const h = await buildHarness()
    t.after(h.close)

    // The owner's own session and an already-stolen one, both live. The
    // principal comes from the real verify path so it carries the session id
    // the revocation sweep must spare.
    const own = await h.sessions.mint({
        userId: h.userId,
        provider: 'google',
        subject: 'pgtest'
    })
    const stolen = await h.sessions.mint({
        userId: h.userId,
        provider: 'google',
        subject: 'pgtest'
    })
    const session = await h.sessions.verify(own.token)
    assert.ok(session)
    assert.ok(session.kind === 'human-session' && session.sessionId)

    await h.passwordController.setupStart(session, REQ)
    await h.passwordController.setPassword(session, {
        password: 'owner-password',
        code: mailedCode(h.sent, 'auth.password_setup')
    })

    // The point of revoke-on-set: the thief is signed out the moment the
    // owner claims a password, while the owner keeps their own session.
    assert.equal(await h.sessions.verify(stolen.token), null)
    assert.ok(await h.sessions.verify(own.token))

    // The change branch sweeps the same way: a session hijacked after the
    // first set dies when the owner rotates the password.
    const stolenLater = await h.sessions.mint({
        userId: h.userId,
        provider: 'google',
        subject: 'pgtest'
    })
    await h.passwordController.setPassword(session, {
        password: 'owner-password-2',
        currentPassword: 'owner-password'
    })
    assert.equal(await h.sessions.verify(stolenLater.token), null)
    assert.ok(await h.sessions.verify(own.token))
})
