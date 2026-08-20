import type {
    NotificationEventKey,
    NotificationProvider
} from '@manyfold/shared'
import { createHmac } from 'node:crypto'

export interface WebhookUrlConfig {
    webhookUrl: string
    secret?: string
}

export interface TelegramConfig {
    botToken: string
    chatId: string
}

export type NotificationConfig = WebhookUrlConfig | TelegramConfig

export interface ProviderRequest {
    url: string
    init: RequestInit
}

export const formatMessage = (
    eventKey: NotificationEventKey,
    payload: Record<string, unknown>
): string => {
    switch (eventKey) {
        case 'user.registered':
            return `🆕 New user registered: ${str(payload.email) ?? str(payload.userId) ?? 'unknown'}`
        case 'subscription.activated':
            return `✅ Subscription activated: ${str(payload.planId) ?? 'unknown plan'} (user ${str(payload.userId) ?? 'unknown'})`
        case 'payment.credited':
            return `💰 Top-up credited: ${formatAmount(payload)} (user ${str(payload.userId) ?? 'unknown'})`
        default:
            return `Manyfold event: ${eventKey as string}`
    }
}

export const buildProviderRequest = (
    provider: NotificationProvider,
    config: NotificationConfig,
    text: string,
    nowMs: number
): ProviderRequest => {
    switch (provider) {
        case 'slack':
            return jsonPost((config as WebhookUrlConfig).webhookUrl, { text })
        case 'discord':
            return jsonPost((config as WebhookUrlConfig).webhookUrl, {
                content: text
            })
        case 'lark': {
            const c = config as WebhookUrlConfig
            const body: Record<string, unknown> = {
                msg_type: 'text',
                content: { text }
            }
            if (c.secret) {
                const timestamp = Math.floor(nowMs / 1000).toString()
                body.timestamp = timestamp
                body.sign = larkSign(timestamp, c.secret)
            }
            return jsonPost(c.webhookUrl, body)
        }
        case 'telegram': {
            const c = config as TelegramConfig
            return jsonPost(
                `https://api.telegram.org/bot${c.botToken}/sendMessage`,
                { chat_id: c.chatId, text }
            )
        }
    }
}

export const larkSign = (timestamp: string, secret: string): string =>
    createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')

const jsonPost = (url: string, body: unknown): ProviderRequest => ({
    url,
    init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }
})

const formatAmount = (payload: Record<string, unknown>): string => {
    const raw = payload.creditedAmount
    const amount = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(amount)) return 'unknown amount'
    const currency =
        typeof payload.currency === 'string'
            ? payload.currency.toUpperCase()
            : 'USD'
    return currency === 'USD'
        ? `$${amount.toFixed(2)}`
        : `${amount.toFixed(2)} ${currency}`
}

const str = (value: unknown): string | null => {
    if (value === null || value === undefined) return null
    const s = String(value)
    return s.length > 0 ? s : null
}