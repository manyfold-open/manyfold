import { createObjectId } from '@manyfold/shared'
import {
    createHmac,
    randomBytes,
    randomInt,
    timingSafeEqual
} from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { emailVerifications, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { EmailService } from '@/modules/email/email.service'
import { SUPPORT_EMAIL } from '@/modules/email/templates/email-content'
import { renderEmail } from '@/modules/email/templates/render-email'

export type VerificationPurpose =
    | 'email_verify'
    | 'password_reset'
    | 'email_change'
    | 'password_setup'

const CODE_TTL_MS = 15 * 60_000
const MAX_ATTEMPTS = 5
const REAUTH_TTL_MS = 10 * 60_000

@Injectable()
export class EmailVerificationService {
    // Keyed so a DB leak of code_hash can't be brute-forced offline (the 6-digit
    // space is only 10^6). Falls back to a non-empty constant only if the master
    // key is somehow unset (CryptoService already requires it at boot).
    private readonly codeKey: Buffer

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly email: EmailService,
        config: ConfigService
    ) {
        const raw = config.get<string>('API_CRYPTO_KEY')?.trim()
        this.codeKey = raw
            ? Buffer.from(raw, 'base64')
            : Buffer.from('manyfold-email-code')
    }

    // Supersede any prior live code for this (email, purpose) so only the newest
    // is valid, then email a fresh 6-digit code. Failures sending mail surface to
    // the caller; the code row is already persisted so a resend can reuse it.
    async issue(args: {
        userId: string
        email: string
        purpose: VerificationPurpose
    }): Promise<void> {
        await this.db
            .update(emailVerifications)
            .set({ consumedAt: new Date() })
            .where(
                and(
                    eq(emailVerifications.email, args.email),
                    eq(emailVerifications.purpose, args.purpose),
                    isNull(emailVerifications.consumedAt)
                )
            )
        const code = sixDigitCode()
        const now = new Date()
        await this.db.insert(emailVerifications).values({
            id: createObjectId('emailVerification'),
            userId: args.userId,
            email: args.email,
            purpose: args.purpose,
            codeHash: this.hmac(code),
            expiresAt: new Date(now.getTime() + CODE_TTL_MS)
        })
        await this.sendEmail(args.email, args.purpose, code)
    }

    // Returns the userId tied to the code on success; null when no live code
    // matches (missing/expired/attempt-locked/mismatch). Single-use is enforced
    // by an atomic consume so a code can never be replayed.
    async verify(args: {
        email: string
        code: string
        purpose: VerificationPurpose
    }): Promise<string | null> {
        const [row] = await this.db
            .select()
            .from(emailVerifications)
            .where(
                and(
                    eq(emailVerifications.email, args.email),
                    eq(emailVerifications.purpose, args.purpose),
                    isNull(emailVerifications.consumedAt)
                )
            )
            .orderBy(desc(emailVerifications.createdAt))
            .limit(1)
        if (!row) return null
        if (row.expiresAt <= new Date()) return null
        if (row.attempts >= MAX_ATTEMPTS) return null
        if (!this.codeMatches(row.codeHash, args.code)) {
            await this.db
                .update(emailVerifications)
                .set({ attempts: row.attempts + 1 })
                .where(eq(emailVerifications.id, row.id))
            return null
        }
        const [consumed] = await this.db
            .update(emailVerifications)
            .set({ consumedAt: new Date() })
            .where(
                and(
                    eq(emailVerifications.id, row.id),
                    isNull(emailVerifications.consumedAt)
                )
            )
            .returning({ userId: emailVerifications.userId })
        return consumed?.userId ?? null
    }

    // The user tied to an unconsumed, unexpired code for this (email, purpose).
    // Lets register reuse a pending unverified account instead of orphaning a new
    // user row on every re-submit.
    async pendingUserId(
        email: string,
        purpose: VerificationPurpose
    ): Promise<string | null> {
        const [row] = await this.db
            .select({ userId: emailVerifications.userId })
            .from(emailVerifications)
            .where(
                and(
                    eq(emailVerifications.email, email),
                    eq(emailVerifications.purpose, purpose),
                    isNull(emailVerifications.consumedAt),
                    gt(emailVerifications.expiresAt, new Date())
                )
            )
            .orderBy(desc(emailVerifications.createdAt))
            .limit(1)
        return row?.userId ?? null
    }

    // A single-use, unguessable proof that the user just re-authenticated via
    // an already-linked OAuth identity (minted by the Google link-mode
    // callback). Stored like a verification code but never emailed — the
    // token itself travels back through the OAuth redirect.
    async issueReauthProof(userId: string, email: string): Promise<string> {
        const token = randomBytes(32).toString('base64url')
        await this.db.insert(emailVerifications).values({
            id: createObjectId('emailVerification'),
            userId,
            email,
            purpose: 'reauth',
            codeHash: this.hmac(token),
            expiresAt: new Date(Date.now() + REAUTH_TTL_MS)
        })
        return token
    }

    // Deliberately validate-only: change-email start may run more than once
    // per proof (the code-entry step has a resend). The proof dies with its
    // 10-minute TTL, and the swap itself voids every pending row for the
    // user — so it can never outlive the change it authorized.
    async validateReauthProof(userId: string, token: string): Promise<boolean> {
        if (!token) return false
        const [row] = await this.db
            .select({ id: emailVerifications.id })
            .from(emailVerifications)
            .where(
                and(
                    eq(emailVerifications.codeHash, this.hmac(token)),
                    eq(emailVerifications.purpose, 'reauth'),
                    eq(emailVerifications.userId, userId),
                    isNull(emailVerifications.consumedAt),
                    gt(emailVerifications.expiresAt, new Date())
                )
            )
            .limit(1)
        return Boolean(row)
    }

    private async sendEmail(
        to: string,
        purpose: VerificationPurpose,
        code: string
    ): Promise<void> {
        const copy: Record<
            VerificationPurpose,
            { subject: string; action: string; noun: string }
        > = {
            email_verify: {
                subject: 'Verify your email',
                action: 'verify your email address',
                noun: 'verification'
            },
            password_reset: {
                subject: 'Reset your password',
                action: 'reset your password',
                noun: 'password reset'
            },
            email_change: {
                subject: 'Confirm your new email',
                action: 'confirm this address as your new sign-in email',
                noun: 'email change'
            },
            password_setup: {
                subject: 'Confirm adding a password',
                action: 'confirm adding password sign-in to your account',
                noun: 'password setup'
            }
        }
        const { subject, action, noun } = copy[purpose]
        const rendered = renderEmail({
            preheader: `Your ${noun} code expires in 15 minutes.`,
            greeting: 'Hi,',
            blocks: [
                { kind: 'paragraph', text: `Your Manyfold ${noun} code is:` },
                { kind: 'code', value: code },
                {
                    kind: 'paragraph',
                    text: `Enter this code to ${action}. It expires in 15 minutes.`
                },
                {
                    kind: 'note',
                    text: 'If you did not request this, you can safely ignore this email — the code only works for the person who asked for it.'
                }
            ],
            footerNote: `Questions? Email ${SUPPORT_EMAIL}.`
        })
        await this.email.send({
            to,
            subject,
            tag: `auth.${purpose}`,
            ...rendered
        })
    }

    private hmac(code: string): string {
        return createHmac('sha256', this.codeKey)
            .update(code.trim())
            .digest('hex')
    }

    private codeMatches(storedHash: string, code: string): boolean {
        const provided = Buffer.from(this.hmac(code))
        const stored = Buffer.from(storedHash)
        if (provided.length !== stored.length) return false
        return timingSafeEqual(provided, stored)
    }
}

const sixDigitCode = (): string =>
    String(randomInt(0, 1_000_000)).padStart(6, '0')
