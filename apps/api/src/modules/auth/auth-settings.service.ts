import type {
    AuthSetupBody,
    LoginProviderSettings,
    OidcTokenSource,
    PublicAuthConfig,
    UpdateLoginProviderSettingsBody
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    ServiceUnavailableException,
    UnauthorizedException
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { appSettings, auditLogs, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    MANAGED_MODELS_PORT,
    type ManagedModelsPort
} from '@/common/ports/managed-models.ports'
import { CryptoService } from '@/modules/secrets/crypto.service'

export const LOGIN_PROVIDER_SETTING_KEY = 'auth.login_provider'

interface StoredGoogleSettings {
    enabled: boolean
    clientId: string
    clientSecretCiphertext: string
    clientSecretVersion: number
}

interface StoredOidcSettings {
    enabled: boolean
    authority: string
    clientId: string
    clientSecretCiphertext: string
    clientSecretVersion: number
    audience: string | null
    scope: string
    tokenSource: OidcTokenSource
    jwksUrl: string | null
    userIdClaim: string
    emailClaim: string
    buttonLabel: string | null
}

interface StoredNetmindSettings {
    enabled: boolean
    authApi: string
    accountsUrl: string
    sysCode: string
    registerUrl: string
}

interface StoredNativeSettings {
    passwordEnabled: boolean
    emailVerificationRequired: boolean
    google: StoredGoogleSettings | null
    oidc: StoredOidcSettings | null
    netmind: StoredNetmindSettings | null
}

interface StoredLoginProviderSettings {
    provider: 'native'
    native: StoredNativeSettings
    initialAdminEmails?: string[]
}

export interface PrivateGoogleSettings {
    enabled: boolean
    clientId: string
    clientSecret: string
}

export interface PrivateOidcSettings {
    enabled: boolean
    authority: string
    clientId: string
    clientSecret: string
    audience: string | null
    scope: string
    tokenSource: OidcTokenSource
    jwksUrl: string | null
    userIdClaim: string
    emailClaim: string
    buttonLabel: string | null
}

export interface PrivateNetmindSettings {
    enabled: boolean
    authApi: string
    accountsUrl: string
    sysCode: string
    registerUrl: string
}

export interface PrivateLoginProviderSettings {
    provider: 'native'
    passwordEnabled: boolean
    emailVerificationRequired: boolean
    google: PrivateGoogleSettings | null
    oidc: PrivateOidcSettings | null
    netmind: PrivateNetmindSettings | null
    initialAdminEmails: string[]
}

@Injectable()
export class AuthSettingsService {
    private cached:
        | {
              expiresAt: number
              value: StoredLoginProviderSettings | null
          }
        | null = null
    private readonly cacheTtlMs = 10_000

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly config: ConfigService,
        @Inject(MANAGED_MODELS_PORT)
        private readonly managedModels: ManagedModelsPort
    ) {}

    async getPublicConfig(): Promise<PublicAuthConfig> {
        const stored = await this.readStoredCached()
        if (!stored) return { configured: false }
        const native = stored.native
        return {
            configured: true,
            provider: 'native',
            methods: {
                password: native.passwordEnabled,
                google: native.google?.enabled ?? false,
                oidc: native.oidc?.enabled ?? false,
                netmind: native.netmind?.enabled ?? false
            },
            emailVerificationRequired: native.emailVerificationRequired,
            oidcButtonLabel: native.oidc?.buttonLabel ?? null,
            netmind: native.netmind?.enabled
                ? {
                      authApi: native.netmind.authApi,
                      accountsUrl: native.netmind.accountsUrl,
                      sysCode: native.netmind.sysCode,
                      registerUrl: native.netmind.registerUrl,
                      ...(await this.managedModels.netmindPublicFlags())
                  }
                : null
        }
    }

    async getView(): Promise<LoginProviderSettings> {
        return this.toView(await this.readStoredCached())
    }

    async getPrivateSettings(): Promise<PrivateLoginProviderSettings> {
        const stored = await this.readStoredCached()
        if (!stored)
            throw new UnauthorizedException('login provider is not configured')
        const native = stored.native
        return {
            provider: 'native',
            passwordEnabled: native.passwordEnabled,
            emailVerificationRequired: native.emailVerificationRequired,
            google: native.google
                ? {
                      enabled: native.google.enabled,
                      clientId: native.google.clientId,
                      clientSecret: this.decryptSecret(
                          native.google.clientSecretCiphertext,
                          native.google.clientSecretVersion
                      )
                  }
                : null,
            oidc: native.oidc
                ? {
                      enabled: native.oidc.enabled,
                      authority: native.oidc.authority,
                      clientId: native.oidc.clientId,
                      clientSecret: this.decryptSecret(
                          native.oidc.clientSecretCiphertext,
                          native.oidc.clientSecretVersion
                      ),
                      audience: native.oidc.audience,
                      scope: native.oidc.scope,
                      tokenSource: native.oidc.tokenSource,
                      jwksUrl: native.oidc.jwksUrl,
                      userIdClaim: native.oidc.userIdClaim,
                      emailClaim: native.oidc.emailClaim,
                      buttonLabel: native.oidc.buttonLabel
                  }
                : null,
            netmind: native.netmind
                ? {
                      enabled: native.netmind.enabled,
                      authApi: native.netmind.authApi,
                      accountsUrl: native.netmind.accountsUrl,
                      sysCode: native.netmind.sysCode,
                      registerUrl: native.netmind.registerUrl
                  }
                : null,
            initialAdminEmails: normalizeEmails(stored.initialAdminEmails)
        }
    }

    async getInitialAdminEmails(): Promise<Set<string>> {
        const stored = await this.readStoredCached()
        return new Set(normalizeEmails(stored?.initialAdminEmails))
    }

    async getNetmindSettings(): Promise<PrivateNetmindSettings | null> {
        const stored = await this.readStoredCached()
        const netmind = stored?.native?.netmind
        if (!netmind) return null
        return {
            enabled: netmind.enabled,
            authApi: netmind.authApi,
            accountsUrl: netmind.accountsUrl,
            sysCode: netmind.sysCode,
            registerUrl: netmind.registerUrl
        }
    }

    async setup(input: AuthSetupBody): Promise<LoginProviderSettings> {
        this.assertSetupToken(input.setupToken)
        const existing = await this.readStoredDirect()
        if (existing)
            throw new ConflictException('login provider is already configured')

        const next = this.normalizeForStorage(input, null, true)
        const now = new Date()
        try {
            const [inserted] = await this.db
                .insert(appSettings)
                .values({
                    key: LOGIN_PROVIDER_SETTING_KEY,
                    valueJson: next as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoNothing()
                .returning()
            if (!inserted)
                throw new ConflictException(
                    'login provider is already configured'
                )
        } catch (err) {
            if (isMissingRelationError(err))
                throw new ServiceUnavailableException(
                    'database migrations are required before auth setup can be saved'
                )
            throw err
        }

        this.invalidate()
        await this.audit(null, 'auth.setup', next.provider, {
            provider: next.provider,
            initialAdminEmails: normalizeEmails(next.initialAdminEmails)
        })
        return this.toView(next)
    }

    async update(
        actorId: string,
        input: UpdateLoginProviderSettingsBody
    ): Promise<LoginProviderSettings> {
        const existing = await this.readStoredDirect()
        const next = this.normalizeForStorage(input, existing, false)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: LOGIN_PROVIDER_SETTING_KEY,
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
                    'database migrations are required before auth settings can be updated'
                )
            throw err
        }

        this.invalidate()
        await this.audit(actorId, 'admin.settings.login_provider.update', null, {
            provider: next.provider,
            initialAdminEmails: normalizeEmails(next.initialAdminEmails)
        })
        return this.toView(next)
    }

    invalidate(): void {
        this.cached = null
    }

    private normalizeForStorage(
        input: UpdateLoginProviderSettingsBody,
        existing: StoredLoginProviderSettings | null,
        requireAdminEmails: boolean
    ): StoredLoginProviderSettings {
        const initialAdminEmails = normalizeEmails(input.initialAdminEmails)
        if (requireAdminEmails && initialAdminEmails.length === 0)
            throw new BadRequestException(
                'initialAdminEmails must include at least one email'
            )
        const adminEmails =
            input.initialAdminEmails !== undefined
                ? initialAdminEmails
                : normalizeEmails(existing?.initialAdminEmails)

        const native: StoredNativeSettings = {
            passwordEnabled: input.passwordEnabled !== false,
            emailVerificationRequired: input.emailVerificationRequired !== false,
            google: this.normalizeGoogle(input, existing?.native?.google ?? null),
            oidc: this.normalizeOidc(input, existing?.native?.oidc ?? null),
            netmind: this.normalizeNetmind(
                input,
                existing?.native?.netmind ?? null
            )
        }

        if (
            !native.passwordEnabled &&
            !native.google?.enabled &&
            !native.oidc?.enabled
        )
            throw new BadRequestException(
                'at least one login method (password, google, or oidc) must be enabled'
            )

        return {
            provider: 'native',
            native,
            initialAdminEmails: adminEmails
        }
    }

    private normalizeGoogle(
        input: UpdateLoginProviderSettingsBody,
        existing: StoredGoogleSettings | null
    ): StoredGoogleSettings | null {
        const clientId =
            optionalString(input.googleClientId) ?? existing?.clientId ?? null
        const secret = this.resolveSecret(
            optionalString(input.googleClientSecret),
            existing
                ? {
                      ciphertext: existing.clientSecretCiphertext,
                      keyVersion: existing.clientSecretVersion
                  }
                : null
        )
        if (!input.googleEnabled && !clientId && !secret) return null
        if (input.googleEnabled) {
            if (!clientId)
                throw new BadRequestException(
                    'googleClientId is required to enable Google login'
                )
            if (!secret)
                throw new BadRequestException(
                    'googleClientSecret is required to enable Google login'
                )
        }
        return {
            enabled: Boolean(input.googleEnabled),
            clientId: clientId ?? '',
            clientSecretCiphertext: secret?.ciphertext ?? '',
            clientSecretVersion: secret?.keyVersion ?? 0
        }
    }

    private normalizeOidc(
        input: UpdateLoginProviderSettingsBody,
        existing: StoredOidcSettings | null
    ): StoredOidcSettings | null {
        const authority = optionalString(input.oidcAuthority)
            ? trimTrailingSlash(input.oidcAuthority as string)
            : (existing?.authority ?? null)
        const clientId =
            optionalString(input.oidcClientId) ?? existing?.clientId ?? null
        const secret = this.resolveSecret(
            optionalString(input.oidcClientSecret),
            existing
                ? {
                      ciphertext: existing.clientSecretCiphertext,
                      keyVersion: existing.clientSecretVersion
                  }
                : null
        )
        const hasAny =
            authority ||
            clientId ||
            secret ||
            existing ||
            input.oidcEnabled
        if (!hasAny) return null
        if (input.oidcEnabled) {
            if (!authority)
                throw new BadRequestException(
                    'oidcAuthority is required to enable OIDC login'
                )
            if (!clientId)
                throw new BadRequestException(
                    'oidcClientId is required to enable OIDC login'
                )
            if (!secret)
                throw new BadRequestException(
                    'oidcClientSecret is required to enable OIDC login'
                )
        }
        return {
            enabled: Boolean(input.oidcEnabled),
            authority: authority ?? '',
            clientId: clientId ?? '',
            clientSecretCiphertext: secret?.ciphertext ?? '',
            clientSecretVersion: secret?.keyVersion ?? 0,
            audience:
                input.oidcAudience !== undefined
                    ? optionalString(input.oidcAudience)
                    : (existing?.audience ?? null),
            scope:
                optionalString(input.oidcScope) ??
                existing?.scope ??
                'openid profile email',
            tokenSource: normalizeTokenSource(
                input.oidcTokenSource ?? existing?.tokenSource
            ),
            jwksUrl:
                input.oidcJwksUrl !== undefined
                    ? optionalString(input.oidcJwksUrl)
                    : (existing?.jwksUrl ?? null),
            userIdClaim:
                optionalString(input.oidcUserIdClaim) ??
                existing?.userIdClaim ??
                'sub',
            emailClaim:
                optionalString(input.oidcEmailClaim) ??
                existing?.emailClaim ??
                'email',
            buttonLabel:
                input.oidcButtonLabel !== undefined
                    ? optionalString(input.oidcButtonLabel)
                    : (existing?.buttonLabel ?? null)
        }
    }

    private normalizeNetmind(
        input: UpdateLoginProviderSettingsBody,
        existing: StoredNetmindSettings | null
    ): StoredNetmindSettings | null {
        const authApi = optionalString(input.netmindAuthApi)
            ? trimTrailingSlash(input.netmindAuthApi as string)
            : (existing?.authApi ?? null)
        const accountsUrl = optionalString(input.netmindAccountsUrl)
            ? trimTrailingSlash(input.netmindAccountsUrl as string)
            : (existing?.accountsUrl ?? null)
        const sysCode =
            optionalString(input.netmindSysCode) ?? existing?.sysCode ?? null
        const registerUrl = optionalString(input.netmindRegisterUrl)
            ? trimTrailingSlash(input.netmindRegisterUrl as string)
            : (existing?.registerUrl ?? null)
        const hasAny =
            authApi ||
            accountsUrl ||
            sysCode ||
            registerUrl ||
            existing ||
            input.netmindEnabled
        if (!hasAny) return null
        // Browser-driven flow: authApi (where to verify) and sysCode (sent on
        // every NetMind request) are the minimum to make any flow work.
        if (input.netmindEnabled) {
            if (!authApi)
                throw new BadRequestException(
                    'netmindAuthApi is required to enable NetMind login'
                )
            if (!sysCode)
                throw new BadRequestException(
                    'netmindSysCode is required to enable NetMind login'
                )
        }
        return {
            enabled: Boolean(input.netmindEnabled),
            authApi: authApi ?? '',
            accountsUrl: accountsUrl ?? '',
            sysCode: sysCode ?? '',
            registerUrl: registerUrl ?? ''
        }
    }

    private resolveSecret(
        provided: string | null,
        existing: { ciphertext: string; keyVersion: number } | null
    ): { ciphertext: string; keyVersion: number } | null {
        if (provided) return this.crypto.encrypt(provided)
        if (existing && existing.ciphertext) return existing
        return null
    }

    private decryptSecret(ciphertext: string, keyVersion: number): string {
        if (!ciphertext) return ''
        return this.crypto.decrypt({ ciphertext, keyVersion })
    }

    private async readStoredCached(): Promise<StoredLoginProviderSettings | null> {
        const now = Date.now()
        if (this.cached && this.cached.expiresAt > now)
            return this.cached.value
        const value = await this.readStoredDirect()
        this.cached = { value, expiresAt: now + this.cacheTtlMs }
        return value
    }

    private async readStoredDirect(): Promise<StoredLoginProviderSettings | null> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, LOGIN_PROVIDER_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (isMissingRelationError(err)) return null
            throw err
        }
        if (!row) return null
        const stored = row.valueJson as unknown as { provider?: unknown }
        // Legacy-row tolerance (S4): a pre-migration `clerk`/`oidc` row is
        // treated as unconfigured rather than parsed as native — the deploy-time
        // data migration rewrites it to native before traffic.
        if (!stored || stored.provider !== 'native') return null
        return row.valueJson as unknown as StoredLoginProviderSettings
    }

    private toView(
        stored: StoredLoginProviderSettings | null
    ): LoginProviderSettings {
        if (!stored)
            return {
                configured: false,
                provider: null,
                password: { enabled: false },
                google: { enabled: false, clientId: '', hasClientSecret: false },
                oidc: null,
                netmind: null,
                emailVerificationRequired: true,
                initialAdminEmails: []
            }
        const native = stored.native
        return {
            configured: true,
            provider: 'native',
            password: { enabled: native.passwordEnabled },
            google: {
                enabled: native.google?.enabled ?? false,
                clientId: native.google?.clientId ?? '',
                hasClientSecret: Boolean(native.google?.clientSecretCiphertext)
            },
            oidc: native.oidc
                ? {
                      enabled: native.oidc.enabled,
                      authority: native.oidc.authority,
                      clientId: native.oidc.clientId,
                      hasClientSecret: Boolean(
                          native.oidc.clientSecretCiphertext
                      ),
                      audience: native.oidc.audience,
                      scope: native.oidc.scope,
                      tokenSource: native.oidc.tokenSource,
                      jwksUrl: native.oidc.jwksUrl,
                      userIdClaim: native.oidc.userIdClaim,
                      emailClaim: native.oidc.emailClaim,
                      buttonLabel: native.oidc.buttonLabel
                  }
                : null,
            netmind: native.netmind
                ? {
                      enabled: native.netmind.enabled,
                      authApi: native.netmind.authApi,
                      accountsUrl: native.netmind.accountsUrl,
                      sysCode: native.netmind.sysCode,
                      registerUrl: native.netmind.registerUrl
                  }
                : null,
            emailVerificationRequired: native.emailVerificationRequired,
            initialAdminEmails: normalizeEmails(stored.initialAdminEmails)
        }
    }

    private assertSetupToken(provided: string): void {
        const expected = this.config.get<string>('AUTH_SETUP_TOKEN')?.trim()
        if (!expected)
            throw new ServiceUnavailableException(
                'AUTH_SETUP_TOKEN is required before first-run setup'
            )
        if (!constantTimeEqual(provided, expected))
            throw new UnauthorizedException('invalid setup token')
    }

    private async audit(
        actorId: string | null,
        action: string,
        subject: string | null,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject: subject ?? LOGIN_PROVIDER_SETTING_KEY,
                meta
            })
        } catch {}
    }
}

const optionalString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const normalizeTokenSource = (value: unknown): OidcTokenSource => {
    if (value === undefined || value === null || value === '')
        return 'access_token'
    if (value === 'access_token' || value === 'id_token') return value
    throw new BadRequestException(
        'oidcTokenSource must be access_token or id_token'
    )
}

const normalizeEmails = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    const emails = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0)
    return Array.from(new Set(emails))
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '')

const constantTimeEqual = (left: string, right: string): boolean => {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    if (leftBuffer.length !== rightBuffer.length) return false
    return timingSafeEqual(leftBuffer, rightBuffer)
}

const isMissingRelationError = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P01'
