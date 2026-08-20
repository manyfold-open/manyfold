import {
    NotificationEventKey,
    NotificationProvider,
    SdkNotificationWebhookSummary,
    SendTestNotificationResult,
    createObjectId
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException
} from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import {
    auditLogs,
    notificationWebhooks,
    type Database,
    type NotificationWebhookRow
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { channelProviderJsonRequest } from '@/modules/channels/providers/channel-http'
import {
    buildProviderRequest,
    formatMessage,
    type NotificationConfig,
    type TelegramConfig,
    type WebhookUrlConfig
} from './notification-formatters'
import type {
    CreateNotificationWebhookDto,
    UpdateNotificationWebhookDto
} from './dto/notification-webhook.dto'

const DELIVERY_TIMEOUT_MS = 8_000

@Injectable()
export class NotificationsService {
    private readonly log = new Logger(NotificationsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService
    ) {}

    dispatch(
        eventKey: NotificationEventKey,
        payload: Record<string, unknown>
    ): void {
        void this.run(eventKey, payload).catch((err) => {
            this.log.error(
                `notification dispatch failed for ${eventKey}: ${(err as Error).message}`
            )
        })
    }

    private async run(
        eventKey: NotificationEventKey,
        payload: Record<string, unknown>
    ): Promise<void> {
        const rows = await this.db
            .select()
            .from(notificationWebhooks)
            .where(eq(notificationWebhooks.enabled, true))
        const subscribed = rows.filter((row) => row.events.includes(eventKey))
        if (subscribed.length === 0) return
        await Promise.allSettled(
            subscribed.map((row) => this.deliver(row, eventKey, payload))
        )
    }

    private async deliver(
        row: NotificationWebhookRow,
        eventKey: NotificationEventKey,
        payload: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.post(row, formatMessage(eventKey, payload))
            await this.markDelivered(row.id)
        } catch (err) {
            const message = (err as Error).message
            this.log.error(
                `notification webhook ${row.id} (${row.provider}) failed: ${message}`
            )
            await this.markError(row.id, message).catch(() => {})
        }
    }

    private async post(
        row: NotificationWebhookRow,
        text: string
    ): Promise<void> {
        const { url, init } = buildProviderRequest(
            row.provider as NotificationProvider,
            this.decryptConfig(row),
            text,
            Date.now()
        )
        const res = await channelProviderJsonRequest({
            provider: row.provider,
            operation: 'notify',
            url,
            init,
            timeoutMs: DELIVERY_TIMEOUT_MS,
            retryBackoffMs: []
        })
        if (!res.ok)
            throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`)
    }

    async list(): Promise<SdkNotificationWebhookSummary[]> {
        const rows = await this.db
            .select()
            .from(notificationWebhooks)
            .orderBy(desc(notificationWebhooks.createdAt))
        return rows.map((row) => this.summarize(row))
    }

    async getSummary(id: string): Promise<SdkNotificationWebhookSummary> {
        return this.summarize(await this.getRow(id))
    }

    async create(
        actorId: string,
        dto: CreateNotificationWebhookDto
    ): Promise<SdkNotificationWebhookSummary> {
        const encrypted = this.crypto.encrypt(
            JSON.stringify(this.configFromCreate(dto))
        )
        const [row] = await this.db
            .insert(notificationWebhooks)
            .values({
                id: createObjectId('notificationWebhook'),
                provider: dto.provider,
                label: dto.label,
                enabled: dto.enabled ?? true,
                events: dto.events,
                configCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion
            })
            .returning()
        await this.audit(actorId, 'admin.notification_webhook.create', {
            id: row.id,
            provider: row.provider
        })
        return this.summarize(row)
    }

    async update(
        actorId: string,
        id: string,
        dto: UpdateNotificationWebhookDto
    ): Promise<SdkNotificationWebhookSummary> {
        const existing = await this.getRow(id)
        const updates: Record<string, unknown> = { updatedAt: new Date() }
        if (dto.label !== undefined) updates.label = dto.label
        if (dto.enabled !== undefined) updates.enabled = dto.enabled
        if (dto.events !== undefined) updates.events = dto.events
        const nextConfig = this.configFromUpdate(existing, dto)
        if (nextConfig) {
            const encrypted = this.crypto.encrypt(JSON.stringify(nextConfig))
            updates.configCiphertext = encrypted.ciphertext
            updates.keyVersion = encrypted.keyVersion
        }
        const [row] = await this.db
            .update(notificationWebhooks)
            .set(updates)
            .where(eq(notificationWebhooks.id, id))
            .returning()
        if (!row) throw new NotFoundException(`notification webhook ${id}`)
        await this.audit(actorId, 'admin.notification_webhook.update', { id })
        return this.summarize(row)
    }

    async remove(actorId: string, id: string): Promise<void> {
        const [row] = await this.db
            .delete(notificationWebhooks)
            .where(eq(notificationWebhooks.id, id))
            .returning()
        if (!row) throw new NotFoundException(`notification webhook ${id}`)
        await this.audit(actorId, 'admin.notification_webhook.delete', { id })
    }

    async testDelivery(id: string): Promise<SendTestNotificationResult> {
        const row = await this.getRow(id)
        try {
            await this.post(row, `🔔 Manyfold test notification — "${row.label}"`)
            await this.markDelivered(row.id)
        } catch (err) {
            const message = (err as Error).message
            await this.markError(row.id, message).catch(() => {})
            throw new BadRequestException(`test delivery failed: ${message}`)
        }
        return {
            ok: true,
            provider: row.provider as NotificationProvider,
            message: 'test notification sent'
        }
    }

    private async getRow(id: string): Promise<NotificationWebhookRow> {
        const [row] = await this.db
            .select()
            .from(notificationWebhooks)
            .where(eq(notificationWebhooks.id, id))
            .limit(1)
        if (!row) throw new NotFoundException(`notification webhook ${id}`)
        return row
    }

    private configFromCreate(
        dto: CreateNotificationWebhookDto
    ): NotificationConfig {
        if (dto.provider === 'telegram')
            return {
                botToken: required(dto.botToken, 'botToken'),
                chatId: required(dto.chatId, 'chatId')
            }
        const webhookUrl = required(dto.webhookUrl, 'webhookUrl')
        const secret = dto.provider === 'lark' ? nonBlank(dto.larkSecret) : null
        return secret ? { webhookUrl, secret } : { webhookUrl }
    }

    private configFromUpdate(
        existing: NotificationWebhookRow,
        dto: UpdateNotificationWebhookDto
    ): NotificationConfig | null {
        const touchesSecret =
            dto.webhookUrl !== undefined ||
            dto.larkSecret !== undefined ||
            dto.botToken !== undefined ||
            dto.chatId !== undefined
        if (!touchesSecret) return null
        const provider = existing.provider as NotificationProvider
        const current = this.decryptConfig(existing)
        if (provider === 'telegram') {
            const c = current as TelegramConfig
            return {
                botToken: nonBlank(dto.botToken) ?? c.botToken,
                chatId: nonBlank(dto.chatId) ?? c.chatId
            }
        }
        const c = current as WebhookUrlConfig
        const webhookUrl = nonBlank(dto.webhookUrl) ?? c.webhookUrl
        if (provider !== 'lark') return { webhookUrl }
        let secret = c.secret
        if (dto.larkSecret === null) secret = undefined
        else if (nonBlank(dto.larkSecret)) secret = dto.larkSecret ?? undefined
        return secret ? { webhookUrl, secret } : { webhookUrl }
    }

    private decryptConfig(row: NotificationWebhookRow): NotificationConfig {
        return JSON.parse(
            this.crypto.decrypt({
                ciphertext: row.configCiphertext,
                keyVersion: row.keyVersion
            })
        ) as NotificationConfig
    }

    private summarize(
        row: NotificationWebhookRow
    ): SdkNotificationWebhookSummary {
        return {
            id: row.id,
            provider: row.provider as NotificationProvider,
            label: row.label,
            enabled: row.enabled,
            events: row.events as NotificationEventKey[],
            configMasked: this.maskConfig(row),
            lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
            lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
            lastErrorMessage: row.lastErrorMessage,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString()
        }
    }

    private maskConfig(row: NotificationWebhookRow): Record<string, string> {
        try {
            const config = this.decryptConfig(row)
            if (row.provider === 'telegram') {
                const c = config as TelegramConfig
                return { botToken: maskBotToken(c.botToken), chatId: c.chatId }
            }
            const c = config as WebhookUrlConfig
            const masked: Record<string, string> = {
                webhookUrl: maskWebhookUrl(c.webhookUrl)
            }
            if (c.secret) masked.larkSecret = '***'
            return masked
        } catch {
            return {}
        }
    }

    private async markDelivered(id: string): Promise<void> {
        await this.db
            .update(notificationWebhooks)
            .set({ lastDeliveryAt: new Date(), lastErrorAt: null, lastErrorMessage: null })
            .where(eq(notificationWebhooks.id, id))
    }

    private async markError(id: string, message: string): Promise<void> {
        await this.db
            .update(notificationWebhooks)
            .set({ lastErrorAt: new Date(), lastErrorMessage: message.slice(0, 500) })
            .where(eq(notificationWebhooks.id, id))
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
                subject: 'notification_webhook',
                meta
            })
        } catch {}
    }
}

const required = (value: string | undefined, field: string): string => {
    const v = nonBlank(value)
    if (!v)
        throw new BadRequestException(`${field} is required for this provider`)
    return v
}

const nonBlank = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const maskWebhookUrl = (raw: string): string => {
    try {
        return `${new URL(raw).origin}/***`
    } catch {
        return '***'
    }
}

const maskBotToken = (raw: string): string => {
    const idx = raw.indexOf(':')
    return idx > 0 ? `${raw.slice(0, idx)}:***` : '***'
}