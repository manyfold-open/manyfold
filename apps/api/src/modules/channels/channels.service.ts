import { DEFAULT_WEB_BASE_URL } from '@/common/brand'
import { configString } from '@/common/config-alias'
import { createObjectId } from '@manyfold/shared'
import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelDeliverySummary,
    ChannelDetail,
    ChannelProviderName,
    ChannelScopeSummary,
    ChannelSessionSummary,
    ChannelSummary,
    ChannelTestResult,
    CreateChannelBody,
    GithubAppManifestResponse,
    UpdateChannelBody
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    forwardRef
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, eq, inArray } from 'drizzle-orm'
import {
    agents,
    type ChannelDeliveryRow,
    type ChannelOrigin,
    type ChannelRow,
    type Database,
    type NewChannelRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    ChannelsRepository,
    type ChannelSessionWithChatTitle
} from './channels.repository'
import { ChannelProviderRegistry } from './channel-provider-registry.service'
import { ChannelManagerService } from './channel-manager.service'
import { ChannelSessionRouter } from './channel-session-router.service'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import type { ChannelProvider } from './channel-provider'
import { buildSlackAppManifest } from './providers/slack.provider'
import {
    buildGithubAppManifest,
    convertGithubAppManifestCode
} from './providers/github.provider'
import { manyfoldProviderToNarraNexusChannelProvider } from '@/modules/narranexus/narranexus-paths'

// GitHub's create-app-from-manifest page can sit open for a while before the
// user clicks Create; the code itself then lives one hour.
const GITHUB_MANIFEST_STATE_TTL_MS = 60 * 60_000

@Injectable()
export class ChannelsService {
    private readonly logger = new Logger(ChannelsService.name)
    private readonly publicBaseUrl: string
    private readonly webBaseUrl: string

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly repo: ChannelsRepository,
        private readonly providers: ChannelProviderRegistry,
        private readonly crypto: CryptoService,
        @Inject(forwardRef(() => ChannelManagerService))
        private readonly manager: ChannelManagerService,
        private readonly router: ChannelSessionRouter,
        private readonly runtimeAccess: RuntimeAccessService,
        config: ConfigService
    ) {
        const fallback = `http://localhost:${config.get('PORT') ?? 2222}`
        this.publicBaseUrl = (
            config.get<string>('PUBLIC_API_BASE_URL') ?? fallback
        ).replace(/\/$/, '')
        this.webBaseUrl = (
            configString(config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? DEFAULT_WEB_BASE_URL
        ).replace(/\/+$/, '')
    }

    async list(
        userId: string,
        opts: { boundAgentId?: string } = {}
    ): Promise<ChannelSummary[]> {
        const rows = await this.repo.listByUser(userId)
        if (rows.length === 0) return []
        const filtered = opts.boundAgentId
            ? rows.filter((r) => r.agentId === opts.boundAgentId)
            : rows
        if (filtered.length === 0) return []
        const agentIds = Array.from(new Set(filtered.map((r) => r.agentId)))
        const agentRows = await this.db
            .select({
                id: agents.id,
                name: agents.name
            })
            .from(agents)
            .where(eq(agents.userId, userId))
        const agentById = new Map(agentRows.map((a) => [a.id, a]))
        return filtered
            .filter((r) => agentIds.includes(r.agentId))
            .map((row) =>
                this.toSummary(row, agentById.get(row.agentId)?.name ?? null)
            )
    }

    async listAll(): Promise<ChannelSummary[]> {
        const rows = await this.repo.listAll()
        if (rows.length === 0) return []
        const agentIds = Array.from(new Set(rows.map((r) => r.agentId)))
        const agentRows = await this.db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        const agentById = new Map(agentRows.map((a) => [a.id, a]))
        return rows.map((row) =>
            this.toSummary(row, agentById.get(row.agentId)?.name ?? null)
        )
    }

    async get(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<ChannelDetail> {
        const row = await this.loadOwned(userId, id, isAdmin)
        const agentName = await this.loadAgentName(row.userId, row.agentId)
        const summary = this.toSummary(row, agentName)
        const deliveries = await this.repo.listDeliveries(row.id, 50)
        return {
            ...summary,
            recentDeliveries: deliveries.map((d) => this.toDeliverySummary(d))
        }
    }

    async slackManifest(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<Record<string, unknown>> {
        const row = await this.loadOwned(userId, id, isAdmin)
        if (row.provider !== 'slack')
            throw new BadRequestException('channel is not a Slack channel')
        return buildSlackAppManifest({
            name: row.label,
            hooksUrl: this.inboundUrlFor(row)
        })
    }

    async githubAppManifest(
        userId: string,
        id: string,
        org?: string
    ): Promise<GithubAppManifestResponse> {
        const row = await this.loadOwned(userId, id)
        if (row.provider !== 'github')
            throw new BadRequestException('channel is not a GitHub channel')
        const state = this.signGithubManifestState(row.id, userId)
        const target = org?.trim()
            ? `https://github.com/organizations/${encodeURIComponent(org.trim())}/settings/apps/new`
            : 'https://github.com/settings/apps/new'
        return {
            postUrl: `${target}?state=${encodeURIComponent(state)}`,
            manifest: buildGithubAppManifest({
                name: row.label,
                homepageUrl: this.webBaseUrl,
                hookUrl: this.inboundUrlFor(row),
                redirectUrl: `${this.publicBaseUrl}/api/channels/github/manifest-callback`
            })
        }
    }

    // GitHub redirected the user's browser back with a one-hour code: turn it
    // into the app's credentials, store them, and register (which activates
    // the channel and captures the app identity into config).
    async completeGithubManifest(args: {
        code: string
        state: string
    }): Promise<{ channelId: string }> {
        const { channelId, userId } = this.verifyGithubManifestState(
            args.state
        )
        const row = await this.repo.getById(channelId)
        if (!row || row.userId !== userId)
            throw new NotFoundException('channel not found')
        if (row.provider !== 'github')
            throw new BadRequestException('channel is not a GitHub channel')
        const conversion = await convertGithubAppManifestCode(args.code)
        const provider = this.providers.get('github')
        const credentials = provider.validateCredentials({
            appId: conversion.appId,
            privateKey: conversion.pem,
            webhookSecret: conversion.webhookSecret
        })
        const encrypted = this.encryptCredentials(credentials)
        await this.repo.update(row.id, {
            credentialsCiphertext: encrypted?.ciphertext ?? null,
            keyVersion: encrypted?.keyVersion ?? 1,
            updatedAt: new Date()
        })
        const refreshed = (await this.repo.getById(row.id)) ?? row
        const config = provider.validateConfig(refreshed.configJson ?? {})
        const registered = await this.runRegister(
            provider,
            refreshed,
            credentials,
            config
        )
        if (!registered.ok)
            throw new BadRequestException(
                registered.message ?? 'github app registration failed'
            )
        const activated = (await this.repo.getById(row.id)) ?? refreshed
        if (activated.status === 'active')
            await this.manager.reload(activated).catch((err) => {
                this.logger.warn(
                    `manager reload failed for channel=${row.id}: ${(err as Error).message}`
                )
            })
        return { channelId: row.id }
    }

    async listScopes(
        userId: string,
        channelId: string
    ): Promise<ChannelScopeSummary[]> {
        await this.loadOwned(userId, channelId)
        const rows = await this.repo.listSessionsForChannel(channelId)
        const grouped = new Map<string, ChannelSessionWithChatTitle[]>()
        for (const row of rows) {
            const key = row.session.scopeKey
            const arr = grouped.get(key) ?? []
            arr.push(row)
            grouped.set(key, arr)
        }
        const summaries: ChannelScopeSummary[] = []
        for (const [scopeKey, items] of grouped.entries()) {
            const active = items.find(
                (i) => i.session.isActive && i.session.archivedAt === null
            )
            const scopeName =
                items.find((i) => i.session.scopeName !== null)?.session
                    .scopeName ?? null
            const lastActivity = items
                .map((i) =>
                    Math.max(
                        i.session.lastInboundAt?.getTime() ?? 0,
                        i.session.lastOutboundAt?.getTime() ?? 0,
                        i.session.updatedAt.getTime()
                    )
                )
                .reduce((a, b) => Math.max(a, b), 0)
            summaries.push({
                scopeKey,
                scopeName,
                activeSession: active
                    ? this.toSessionSummary(active)
                    : null,
                sessionCount: items.length,
                lastActivityAt:
                    lastActivity > 0
                        ? new Date(lastActivity).toISOString()
                        : null
            })
        }
        return summaries.sort((a, b) =>
            (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '')
        )
    }

    async listChannelSessions(
        userId: string,
        channelId: string,
        opts: { scopeKey?: string; includeArchived?: boolean } = {}
    ): Promise<ChannelSessionSummary[]> {
        await this.loadOwned(userId, channelId)
        const rows = await this.repo.listSessionsForChannel(channelId, opts)
        return rows.map((r) => this.toSessionSummary(r))
    }

    async createChannelSession(
        userId: string,
        channelId: string,
        scopeKey: string,
        displayName: string | null
    ): Promise<ChannelSessionSummary> {
        const channel = await this.loadOwned(userId, channelId)
        if (!scopeKey.trim())
            throw new BadRequestException('scopeKey is required')
        const existing = await this.repo.findActiveSession(channelId, scopeKey)
        const resolved = await this.router.fork(channel, scopeKey, {
            displayName,
            scopeName: existing?.scopeName ?? null,
            remoteUserId: existing?.remoteUserId ?? null,
            remoteThreadId: existing?.remoteThreadId ?? null
        })
        const item: ChannelSessionWithChatTitle = {
            session: resolved.session,
            chatTitle: null
        }
        return this.toSessionSummary(item)
    }

    async updateChannelSession(
        userId: string,
        channelId: string,
        channelSessionId: string,
        patch: { displayName?: string | null; makeActive?: boolean }
    ): Promise<ChannelSessionSummary> {
        const channel = await this.loadOwned(userId, channelId)
        const row = await this.repo.findSessionById(channelSessionId)
        if (!row || row.channelId !== channel.id)
            throw new NotFoundException('channel session not found')
        if (patch.displayName !== undefined)
            await this.repo.renameSession(row.id, patch.displayName)
        if (patch.makeActive === true && row.archivedAt === null && !row.isActive) {
            await this.router.switchTo(channel, row.scopeKey, row.id)
        }
        const updated = await this.repo.findSessionById(row.id)
        if (!updated)
            throw new NotFoundException('channel session not found after update')
        return this.toSessionSummary({ session: updated, chatTitle: null })
    }

    async archiveChannelSession(
        userId: string,
        channelId: string,
        channelSessionId: string,
        opts: { activateFallback?: boolean } = {}
    ): Promise<{
        archived: ChannelSessionSummary
        fallbackActivated: ChannelSessionSummary | null
    }> {
        const channel = await this.loadOwned(userId, channelId)
        const row = await this.repo.findSessionById(channelSessionId)
        if (!row || row.channelId !== channel.id)
            throw new NotFoundException('channel session not found')
        const result = await this.repo.archiveSession(row.id, opts)
        return {
            archived: this.toSessionSummary({
                session: result.archived,
                chatTitle: null
            }),
            fallbackActivated: result.fallbackActivated
                ? this.toSessionSummary({
                      session: result.fallbackActivated,
                      chatTitle: null
                  })
                : null
        }
    }

    async listDeliveries(
        userId: string,
        channelId: string,
        limit = 50
    ): Promise<ChannelDeliverySummary[]> {
        await this.loadOwned(userId, channelId)
        const rows = await this.repo.listDeliveries(channelId, limit)
        return rows.map((d) => this.toDeliverySummary(d))
    }

    async create(
        userId: string,
        body: CreateChannelBody,
        opts: {
            externalId?: string | null
            origin?: ChannelOrigin
        } = {}
    ): Promise<ChannelDetail> {
        await this.assertAgentOwned(userId, body.agentId)
        // Managed mirrors are bounded by their source framework's own
        // bindings, not the user's plan.
        if (!opts.origin) await this.runtimeAccess.reserveChannelSlot(userId)
        const provider = this.providers.get(body.provider)
        const config = provider.validateConfig(body.config, { strict: true })
        await this.assertAgentManagedReplyAllowed(
            body.agentId,
            body.provider,
            config,
            opts.origin ?? null
        )
        const credentials = provider.validateCredentials(
            body.credentials ?? null
        )
        const encrypted = this.encryptCredentials(credentials)
        const activateImmediately =
            body.provider === 'lark' &&
            (config as { subscriptionMode?: unknown }).subscriptionMode ===
                'websocket'
        const now = new Date()
        const id = createObjectId('channel')
        const inserted = await this.insertChannel({
            id,
            userId,
            agentId: body.agentId,
            provider: body.provider,
            label: body.label.trim(),
            status: activateImmediately ? 'active' : 'draft',
            configJson: config as Record<string, unknown>,
            credentialsCiphertext: encrypted?.ciphertext ?? null,
            keyVersion: encrypted?.keyVersion ?? 1,
            externalId: opts.externalId ?? null,
            origin: opts.origin ?? null,
            lastConnectedAt: null,
            lastErrorAt: null,
            lastErrorMessage: null,
            createdAt: now,
            updatedAt: now
        })
        await this.runRegister(provider, inserted, credentials, config)
        const latest = (await this.repo.getById(id)) ?? inserted
        if (latest.status === 'active')
            await this.manager.reload(latest).catch((err) => {
                this.logger.warn(
                    `manager reload failed for channel=${id}: ${(err as Error).message}`
                )
            })
        return this.get(userId, id)
    }

    async update(
        userId: string,
        id: string,
        body: UpdateChannelBody,
        isAdmin = false
    ): Promise<ChannelDetail> {
        const existing = await this.loadOwned(userId, id, isAdmin)
        // The sync reconciler (and operators) go through the admin path;
        // owners must edit the source binding in the NarraNexus dashboard.
        if (existing.origin && !isAdmin)
            throw new ConflictException(
                'this channel mirrors a NarraNexus binding — manage it in the NarraNexus dashboard'
            )
        const provider = this.providers.get(existing.provider)
        const nextConfig =
            body.config !== undefined
                ? provider.validateConfig(body.config, { strict: true })
                : (existing.configJson as ChannelConfig)
        // Checked on the effective (agent, config) pair before the rebind
        // mutation below, so a config change, a rebind, or both can never
        // leave agentManagedReply pointing at an agent that cannot deliver.
        await this.assertAgentManagedReplyAllowed(
            body.agentId ?? existing.agentId,
            existing.provider,
            nextConfig,
            existing.origin ?? null
        )
        if (body.agentId !== undefined && body.agentId !== existing.agentId) {
            // Ownership is checked against the channel owner, not the caller:
            // the admin path may update on behalf of another user, and the
            // target agent must belong to that user.
            await this.assertAgentOwned(existing.userId, body.agentId)
            const rebound = await this.repo.rebindAgent(id, body.agentId)
            if (!rebound) throw new NotFoundException('channel not found')
        }
        const patch: Partial<ChannelRow> = {}
        if (body.label !== undefined) patch.label = body.label.trim()
        if (body.config !== undefined)
            patch.configJson = nextConfig as Record<string, unknown>
        if (body.credentials !== undefined) {
            const credentials = provider.validateCredentials(body.credentials)
            const encrypted = this.encryptCredentials(credentials)
            patch.credentialsCiphertext = encrypted?.ciphertext ?? null
            patch.keyVersion = encrypted?.keyVersion ?? 1
        }
        if (body.status !== undefined) patch.status = body.status
        if (
            body.config !== undefined ||
            body.credentials !== undefined ||
            body.status !== undefined
        ) {
            // A user-touched channel deserves a fresh reconnect attempt on the
            // next lease tick instead of waiting out an old backoff window.
            patch.reconnectAttempts = 0
            patch.nextReconnectAt = null
        }
        const updated = await this.repo.update(id, patch)
        if (!updated) throw new NotFoundException('channel not found')
        if (body.credentials !== undefined && provider.register) {
            const refreshed = (await this.repo.getById(id)) ?? updated
            const config = provider.validateConfig(refreshed.configJson)
            const credentials = this.decryptCredentials(refreshed)
            await this.runRegister(provider, refreshed, credentials, config)
        }
        await this.manager.reload(updated).catch((err) => {
            this.logger.warn(
                `manager reload failed for channel=${id}: ${(err as Error).message}`
            )
        })
        return this.get(userId, id, isAdmin)
    }

    async delete(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<void> {
        const owned = await this.loadOwned(userId, id, isAdmin)
        if (owned.origin && !isAdmin)
            throw new ConflictException(
                'this channel mirrors a NarraNexus binding — manage it in the NarraNexus dashboard'
            )
        const provider = this.providers.get(owned.provider)
        if (provider.unregister) {
            try {
                const config = provider.validateConfig(owned.configJson)
                const credentials = this.decryptCredentials(owned)
                await provider.unregister({
                    channel: owned,
                    config,
                    credentials
                })
            } catch (err) {
                this.logger.warn(
                    `unregister failed for channel=${id}: ${(err as Error).message}`
                )
            }
        }
        await this.manager.stopChannel(id).catch((err) => {
            this.logger.warn(
                `manager stop failed for channel=${id}: ${(err as Error).message}`
            )
        })
        await this.repo.delete(id)
    }

    private async runRegister(
        provider: ChannelProvider,
        row: ChannelRow,
        credentials: ChannelCredentials | null,
        config: ChannelConfig
    ): Promise<{ ok: boolean; message: string | null }> {
        if (!provider.register) return { ok: true, message: null }
        const inboundUrl = this.inboundUrlFor(row)
        // A failed re-register must not knock an active channel out of webhook
        // intake (the controller rejects and drops inbound for non-active
        // channels); record the error fields and report failure to the caller.
        const degradeOnFailure = row.status !== 'active'
        try {
            const result = await provider.register(
                { channel: row, config, credentials },
                inboundUrl
            )
            const patch: Partial<NewChannelRow> = {}
            if (result.configPatch)
                patch.configJson = result.configPatch as Record<string, unknown>
            if (result.credentialsPatch) {
                const encrypted = this.encryptCredentials(
                    result.credentialsPatch
                )
                patch.credentialsCiphertext = encrypted?.ciphertext ?? null
                patch.keyVersion = encrypted?.keyVersion ?? 1
            }
            if (result.activate) {
                patch.status = 'active'
                patch.lastConnectedAt = new Date()
                patch.lastErrorAt = null
                patch.lastErrorMessage = null
                patch.reconnectAttempts = 0
                patch.nextReconnectAt = null
            } else if (!result.ok) {
                if (degradeOnFailure) patch.status = 'error'
                patch.lastErrorAt = new Date()
                patch.lastErrorMessage = result.message ?? 'registration failed'
            }
            if (Object.keys(patch).length > 0)
                await this.repo.update(row.id, patch)
            return {
                ok: result.ok,
                message: result.message ?? null
            }
        } catch (err) {
            this.logger.warn(
                `register failed for channel=${row.id}: ${(err as Error).message}`
            )
            await this.repo
                .update(row.id, {
                    ...(degradeOnFailure ? { status: 'error' as const } : {}),
                    lastErrorAt: new Date(),
                    lastErrorMessage: (err as Error).message
                })
                .catch(() => {})
            return { ok: false, message: (err as Error).message }
        }
    }

    async test(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<ChannelTestResult> {
        const channel = await this.loadOwned(userId, id, isAdmin)
        const provider = this.providers.get(channel.provider)
        if (!provider.test)
            return { ok: true, message: 'provider has no test capability' }
        const runOnce = async (row: ChannelRow): Promise<ChannelTestResult> => {
            const cfg = provider.validateConfig(row.configJson)
            const cred = this.decryptCredentials(row)
            return provider.test!({
                channel: row,
                config: cfg,
                credentials: cred
            })
        }
        const first = await runOnce(channel)
        const config = provider.validateConfig(channel.configJson)
        const credentials = this.decryptCredentials(channel)
        if (first.ok) return first
        if (
            channel.provider === 'lark' &&
            (config as { subscriptionMode?: unknown }).subscriptionMode ===
                'websocket' &&
            channel.status === 'active'
        ) {
            await this.manager.reload(channel).catch((err) => {
                this.logger.warn(
                    `websocket restart failed for channel=${id}: ${(err as Error).message}`
                )
            })
            const refreshed = await this.repo.getById(id)
            if (!refreshed) return first
            if (refreshed.status === 'error' && refreshed.lastErrorMessage)
                return {
                    ok: false,
                    message: `${first.message}\n\n→ WebSocket restart failed: ${refreshed.lastErrorMessage}`
                }
            const second = await runOnce(refreshed)
            return {
                ok: second.ok,
                message: second.ok
                    ? `(websocket restarted)\n${second.message}`
                    : second.message
            }
        }
        if (!provider.register) return first
        const registration = await this.runRegister(
            provider,
            channel,
            credentials,
            config
        )
        const refreshed = await this.repo.getById(id)
        if (!refreshed) return first
        if (!registration.ok) {
            const hint =
                channel.provider === 'telegram'
                    ? '\n  (Check PUBLIC_API_BASE_URL — Telegram requires a public HTTPS URL.)'
                    : ''
            return {
                ok: false,
                message: `${first.message}\n\n→ Auto-register failed: ${registration.message ?? 'registration failed'}${hint}`
            }
        }
        const second = await runOnce(refreshed)
        return {
            ok: second.ok,
            message: second.ok
                ? `(auto-registered)\n${second.message}`
                : second.message
        }
    }

    async register(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<ChannelTestResult> {
        const channel = await this.loadOwned(userId, id, isAdmin)
        const provider = this.providers.get(channel.provider)
        if (!provider.register)
            return {
                ok: true,
                message: 'provider does not require registration'
            }
        const config = provider.validateConfig(channel.configJson)
        const credentials = this.decryptCredentials(channel)
        const registration = await this.runRegister(
            provider,
            channel,
            credentials,
            config
        )
        if (!registration.ok)
            return {
                ok: false,
                message: registration.message ?? 'registration failed'
            }
        return { ok: true, message: 'registration completed' }
    }

    async loadOwned(
        userId: string,
        id: string,
        isAdmin = false
    ): Promise<ChannelRow> {
        const row = isAdmin
            ? await this.repo.getById(id)
            : await this.repo.getOwned(id, userId)
        if (!row) throw new NotFoundException('channel not found')
        return row
    }

    async loadActive(channelId: string): Promise<ChannelRow> {
        const row = await this.repo.getById(channelId)
        if (!row) throw new NotFoundException('channel not found')
        if (row.status !== 'active' && row.status !== 'draft')
            throw new BadRequestException(`channel is ${row.status}`)
        return row
    }

    async markConnected(id: string): Promise<void> {
        await this.repo.update(id, {
            lastConnectedAt: new Date(),
            lastErrorAt: null,
            lastErrorMessage: null,
            reconnectAttempts: 0,
            nextReconnectAt: null,
            status: 'active'
        })
    }

    async markError(id: string, message: string): Promise<void> {
        await this.repo.update(id, {
            lastErrorAt: new Date(),
            lastErrorMessage: message,
            status: 'error'
        })
    }

    decryptCredentials(channel: ChannelRow): ChannelCredentials | null {
        if (!channel.credentialsCiphertext) return null
        try {
            const plain = this.crypto.decrypt({
                ciphertext: channel.credentialsCiphertext,
                keyVersion: channel.keyVersion
            })
            return JSON.parse(plain) as ChannelCredentials
        } catch (err) {
            this.logger.error(
                `failed to decrypt credentials for channel=${channel.id}: ${(err as Error).message}`
            )
            return null
        }
    }

    private encryptCredentials(
        credentials: ChannelCredentials | null
    ): { ciphertext: string; keyVersion: number } | null {
        if (!credentials) return null
        return this.crypto.encrypt(JSON.stringify(credentials))
    }

    // The state that rides GitHub's create-app-from-manifest round trip. The
    // callback is unauthenticated (GitHub redirects the user's browser), so
    // the channel and owner are recovered from this signed value, never from
    // the request.
    private signGithubManifestState(channelId: string, userId: string): string {
        const enc = this.crypto.encrypt(
            JSON.stringify({
                c: channelId,
                u: userId,
                e: Date.now() + GITHUB_MANIFEST_STATE_TTL_MS
            })
        )
        // base64url so the value survives the github.com round-trip — raw
        // base64 +/= get mangled in query strings.
        const packed = Buffer.from(enc.ciphertext, 'base64').toString(
            'base64url'
        )
        return `${enc.keyVersion}.${packed}`
    }

    private verifyGithubManifestState(state: string): {
        channelId: string
        userId: string
    } {
        const dot = state.indexOf('.')
        if (dot <= 0) throw new BadRequestException('invalid state')
        const keyVersion = Number(state.slice(0, dot))
        const packed = state.slice(dot + 1)
        if (!Number.isInteger(keyVersion) || !packed)
            throw new BadRequestException('invalid state')
        const ciphertext = Buffer.from(packed, 'base64url').toString('base64')
        let payload: { c?: unknown; u?: unknown; e?: unknown }
        try {
            payload = JSON.parse(
                this.crypto.decrypt({ ciphertext, keyVersion })
            ) as { c?: unknown; u?: unknown; e?: unknown }
        } catch {
            throw new BadRequestException('invalid state')
        }
        if (
            typeof payload.c !== 'string' ||
            typeof payload.u !== 'string' ||
            typeof payload.e !== 'number'
        )
            throw new BadRequestException('invalid state')
        if (payload.e < Date.now())
            throw new BadRequestException('state expired')
        return { channelId: payload.c, userId: payload.u }
    }

    // Insert, mapping the (provider, external_id) unique-index violation to a
    // friendly 409 so a second binding of the same external account (e.g. an
    // iLink bot already connected) fails cleanly instead of leaking a raw DB
    // error.
    private async insertChannel(row: NewChannelRow): Promise<ChannelRow> {
        try {
            return await this.repo.insert(row)
        } catch (err) {
            if ((err as { code?: string } | null)?.code === '23505')
                throw new ConflictException({
                    code: 'external_account_already_bound',
                    message:
                        'this external account is already connected to a channel'
                })
            throw err
        }
    }

    private async assertAgentOwned(
        userId: string,
        agentId: string
    ): Promise<void> {
        const rows = await this.db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        if (rows.length === 0) throw new NotFoundException('agent not found')
    }

    // agentManagedReply suppresses Manyfold's outbound delivery, so it is only
    // valid where the agent can deliver instead: a narranexus agent on a
    // provider NarraNexus maps to a WorkingSource. Anything else would leave
    // the channel silent.
    private async assertAgentManagedReplyAllowed(
        agentId: string,
        provider: ChannelProviderName,
        config: ChannelConfig,
        origin: ChannelOrigin | null
    ): Promise<void> {
        if (config.agentManagedReply !== true) return
        if (
            !manyfoldProviderToNarraNexusChannelProvider(provider, {
                mirrored: origin?.kind === 'narranexus'
            })
        )
            throw new BadRequestException(
                `config.agentManagedReply is not supported for provider "${provider}"`
            )
        const rows = await this.db
            .select({ framework: agents.framework })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (rows[0]?.framework !== 'narranexus')
            throw new BadRequestException(
                'config.agentManagedReply requires a narranexus agent'
            )
    }

    private async loadAgentName(
        userId: string,
        agentId: string
    ): Promise<string | null> {
        const rows = await this.db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
            .limit(1)
        return rows[0]?.name ?? null
    }

    private toSummary(
        row: ChannelRow,
        agentName: string | null
    ): ChannelSummary {
        return {
            id: row.id,
            userId: row.userId,
            agentId: row.agentId,
            agent: { id: row.agentId, name: agentName ?? row.agentId },
            provider: row.provider,
            label: row.label,
            status: row.status,
            config: row.configJson as ChannelConfig,
            managed: row.origin != null,
            inboundUrl: this.inboundUrlFor(row),
            lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
            lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
            lastErrorMessage: row.lastErrorMessage,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    private toSessionSummary(
        item: ChannelSessionWithChatTitle
    ): ChannelSessionSummary {
        const s = item.session
        return {
            channelSessionId: s.id,
            chatSessionId: s.chatSessionId,
            scopeKey: s.scopeKey,
            scopeName: s.scopeName,
            displayName: s.displayName,
            chatTitle: item.chatTitle,
            isActive: s.isActive,
            archivedAt: s.archivedAt?.toISOString() ?? null,
            lastInboundAt: s.lastInboundAt?.toISOString() ?? null,
            lastOutboundAt: s.lastOutboundAt?.toISOString() ?? null,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString()
        }
    }

    private toDeliverySummary(row: ChannelDeliveryRow): ChannelDeliverySummary {
        return {
            id: String(row.id),
            channelId: row.channelId,
            chatSessionId: row.chatSessionId,
            chatMessageId: row.chatMessageId,
            direction: row.direction,
            scopeKey: row.scopeKey,
            providerEventId: row.providerEventId,
            providerMessageId: row.providerMessageId,
            summaryText: row.summaryText,
            status: row.status,
            errorMessage: row.errorMessage,
            createdAt: row.createdAt.toISOString()
        }
    }

    private inboundUrlFor(row: ChannelRow): string {
        return `${this.publicBaseUrl}/api/channels/hooks/${row.provider}/${row.id}`
    }
}
