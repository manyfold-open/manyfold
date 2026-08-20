import type {
    EmailProviderKind,
    EmailProviderSettings,
    UpdateEmailProviderSettingsBody
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { appSettings, auditLogs, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'

export const EMAIL_PROVIDER_SETTING_KEY = 'email_provider'

interface StoredResendSettings {
    from: string
    replyTo: string | null
    apiKeyCiphertext: string
    apiKeyVersion: number
    apiKeyMasked: string
}

interface StoredSmtpSettings {
    host: string
    port: number
    secure: boolean
    username: string | null
    from: string
    replyTo: string | null
    passwordCiphertext: string | null
    passwordVersion: number | null
    passwordMasked: string | null
}

interface StoredEmailProviderSettings {
    provider: EmailProviderKind
    resend?: StoredResendSettings
    smtp?: StoredSmtpSettings
}

export type ResolvedEmailProviderConfig =
    | { provider: 'console' }
    | {
          provider: 'resend'
          apiKey: string
          from: string
          replyTo: string | null
      }
    | {
          provider: 'smtp'
          host: string
          port: number
          secure: boolean
          username: string | null
          password: string | null
          from: string
          replyTo: string | null
      }

@Injectable()
export class EmailSettingsService {
    private cached:
        | {
              expiresAt: number
              value: StoredEmailProviderSettings | null
          }
        | null = null
    private readonly cacheTtlMs = 10_000

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    async getView(): Promise<EmailProviderSettings> {
        return this.toView(await this.readStoredCached())
    }

    async getResolvedConfig(): Promise<ResolvedEmailProviderConfig> {
        return this.resolveStored(await this.readStoredCached())
    }

    private resolveStored(
        stored: StoredEmailProviderSettings | null
    ): ResolvedEmailProviderConfig {
        if (!stored || stored.provider === 'console')
            return { provider: 'console' }
        if (stored.provider === 'resend') {
            const resend = stored.resend
            if (!resend)
                throw new BadRequestException(
                    'stored Resend settings are invalid'
                )
            return {
                provider: 'resend',
                apiKey: this.crypto.decrypt({
                    ciphertext: resend.apiKeyCiphertext,
                    keyVersion: resend.apiKeyVersion
                }),
                from: resend.from,
                replyTo: resend.replyTo
            }
        }
        const smtp = stored.smtp
        if (!smtp)
            throw new BadRequestException('stored SMTP settings are invalid')
        return {
            provider: 'smtp',
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            username: smtp.username,
            password:
                smtp.passwordCiphertext !== null &&
                smtp.passwordVersion !== null
                    ? this.crypto.decrypt({
                          ciphertext: smtp.passwordCiphertext,
                          keyVersion: smtp.passwordVersion
                      })
                    : null,
            from: smtp.from,
            replyTo: smtp.replyTo
        }
    }

    async update(
        actorId: string,
        input: UpdateEmailProviderSettingsBody
    ): Promise<EmailProviderSettings> {
        const existing = await this.readStoredDirect()
        const next = this.normalizeForStorage(input, existing)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: EMAIL_PROVIDER_SETTING_KEY,
                    valueJson: next as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: next as unknown as Record<string, unknown>,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (isMissingRelationError(err))
                throw new ServiceUnavailableException(
                    'database migrations are required before admin settings can be updated'
                )
            throw err
        }
        this.invalidate()
        await this.audit(actorId, 'admin.settings.email_provider.update', {
            provider: next.provider,
            resendFrom: next.resend?.from ?? null,
            smtpHost: next.smtp?.host ?? null
        })
        return this.toView(next)
    }

    invalidate(): void {
        this.cached = null
    }

    private normalizeForStorage(
        input: UpdateEmailProviderSettingsBody,
        existing: StoredEmailProviderSettings | null
    ): StoredEmailProviderSettings {
        // Every branch carries the other providers' stored blocks through, so
        // switching providers never forces the admin to re-enter a secret.
        const carried = {
            ...(existing?.resend ? { resend: existing.resend } : {}),
            ...(existing?.smtp ? { smtp: existing.smtp } : {})
        }

        if (input.provider === 'console')
            return { provider: 'console', ...carried }

        if (input.provider === 'resend') {
            const from = requiredString(input.resendFrom, 'resendFrom')
            assertEmailAddress(from, 'resendFrom')
            const replyTo = optionalString(input.resendReplyTo)
            if (replyTo) assertEmailAddress(replyTo, 'resendReplyTo')

            const apiKey = optionalString(input.resendApiKey)
            let resend: StoredResendSettings
            if (apiKey) {
                const encrypted = this.crypto.encrypt(apiKey)
                resend = {
                    from,
                    replyTo,
                    apiKeyCiphertext: encrypted.ciphertext,
                    apiKeyVersion: encrypted.keyVersion,
                    apiKeyMasked: maskSecret(apiKey)
                }
            } else {
                if (!existing?.resend)
                    throw new BadRequestException('resendApiKey is required')
                resend = { ...existing.resend, from, replyTo }
            }
            return { provider: 'resend', ...carried, resend }
        }

        if (input.provider !== 'smtp')
            throw new BadRequestException(
                'provider must be console, resend or smtp'
            )

        const host = requiredString(input.smtpHost, 'smtpHost')
        const port =
            typeof input.smtpPort === 'number'
                ? input.smtpPort
                : existing?.smtp?.port
        if (
            port === undefined ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65_535
        )
            throw new BadRequestException('smtpPort must be between 1 and 65535')
        const secure =
            typeof input.smtpSecure === 'boolean'
                ? input.smtpSecure
                : (existing?.smtp?.secure ?? false)
        const username = optionalString(input.smtpUsername)
        const from = requiredString(input.smtpFrom, 'smtpFrom')
        assertEmailAddress(from, 'smtpFrom')
        const replyTo = optionalString(input.smtpReplyTo)
        if (replyTo) assertEmailAddress(replyTo, 'smtpReplyTo')

        const password = optionalString(input.smtpPassword)
        let secret: Pick<
            StoredSmtpSettings,
            'passwordCiphertext' | 'passwordVersion' | 'passwordMasked'
        >
        if (password) {
            const encrypted = this.crypto.encrypt(password)
            secret = {
                passwordCiphertext: encrypted.ciphertext,
                passwordVersion: encrypted.keyVersion,
                passwordMasked: maskSecret(password)
            }
        } else if (existing?.smtp?.passwordCiphertext) {
            secret = {
                passwordCiphertext: existing.smtp.passwordCiphertext,
                passwordVersion: existing.smtp.passwordVersion,
                passwordMasked: existing.smtp.passwordMasked
            }
        } else if (username) {
            throw new BadRequestException(
                'smtpPassword is required when smtpUsername is set'
            )
        } else {
            secret = {
                passwordCiphertext: null,
                passwordVersion: null,
                passwordMasked: null
            }
        }

        return {
            provider: 'smtp',
            ...carried,
            smtp: { host, port, secure, username, from, replyTo, ...secret }
        }
    }

    private async readStoredCached(): Promise<StoredEmailProviderSettings | null> {
        const now = Date.now()
        if (this.cached && this.cached.expiresAt > now)
            return this.cached.value
        const value = await this.readStoredDirect()
        this.cached = { value, expiresAt: now + this.cacheTtlMs }
        return value
    }

    private async readStoredDirect(): Promise<StoredEmailProviderSettings | null> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, EMAIL_PROVIDER_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (isMissingRelationError(err)) return null
            throw err
        }
        if (!row) return null
        return row.valueJson as unknown as StoredEmailProviderSettings
    }

    private toView(
        stored: StoredEmailProviderSettings | null
    ): EmailProviderSettings {
        if (!stored) return { provider: 'console', resend: null, smtp: null }
        return {
            provider: stored.provider,
            resend: stored.resend
                ? {
                      from: stored.resend.from,
                      replyTo: stored.resend.replyTo,
                      apiKeyMasked: stored.resend.apiKeyMasked
                  }
                : null,
            smtp: stored.smtp
                ? {
                      host: stored.smtp.host,
                      port: stored.smtp.port,
                      secure: stored.smtp.secure,
                      username: stored.smtp.username,
                      from: stored.smtp.from,
                      replyTo: stored.smtp.replyTo,
                      passwordMasked: stored.smtp.passwordMasked
                  }
                : null
        }
    }

    private async audit(
        actorId: string,
        action: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject: EMAIL_PROVIDER_SETTING_KEY,
                meta
            })
        } catch {}
    }
}

const requiredString = (value: unknown, field: string): string => {
    const normalized = optionalString(value)
    if (!normalized) throw new BadRequestException(`${field} is required`)
    return normalized
}

const optionalString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const assertEmailAddress = (value: string, field: string): void => {
    const match = value.match(/<([^<>]+)>\s*$/)
    const address = (match ? match[1] : value).trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))
        throw new BadRequestException(
            `${field} must be an email address or "Name <email>"`
        )
}

const maskSecret = (raw: string): string => {
    const trimmed = raw.trim()
    if (trimmed.length <= 8) return '***'
    const dashIdx = trimmed.search(/[_-]/)
    const prefixEnd =
        dashIdx > 0 && dashIdx < 10 ? dashIdx + 1 : Math.min(4, trimmed.length)
    return `${trimmed.slice(0, prefixEnd)}***${trimmed.slice(-4)}`
}

const isMissingRelationError = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P01'
