import type {
    ChannelTestResult,
    LineChannelConfig,
    LineChannelCredentials
} from '@manyfold/shared'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHandle,
    type ChannelProvider,
    type ChannelSendTarget,
    type InboundActorPolicy,
    type InboundRequest,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type RegistrationResult,
    type SendTextOptions,
    type SignatureCheck
} from '../channel-provider'
import {
    channelProviderJsonRequest,
    type ChannelProviderJsonResponse
} from './channel-http'
import { parseResetOnIdleMins } from '../config-helpers'
import {
    ChannelSendError,
    type ChannelSendErrorKind
} from '../channel-send-error'
import { chunkText } from '../text-chunk'
import { markdownToLinePlainText } from './line-format'

const LINE_API_BASE = 'https://api.line.me'
const LINE_DATA_API_BASE = 'https://api-data.line.me'
// A LINE text message object caps at 5000 characters.
const MAX_MESSAGE_LEN = 5000
// One push request carries at most 5 message objects.
const MAX_MESSAGES_PER_PUSH = 5
const LINE_CONTENT_PREFIX = 'line-content:'
const LINE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const LINE_DOWNLOAD_TIMEOUT_MS = 30_000
// loadingSeconds only accepts multiples of 5 up to 60; re-fire just inside the
// maximum so a long turn keeps the animation alive.
const LOADING_SECONDS = 60
const LOADING_REFRESH_MS = 50_000
const LOADING_MAX_MS = 10 * 60_000
const NAME_CACHE_MAX = 4096

interface LineWebhookBody {
    destination?: string
    events?: LineWebhookEvent[]
}

interface LineWebhookEvent {
    type?: string
    webhookEventId?: string
    timestamp?: number
    source?: LineEventSource
    message?: LineInboundMessage
}

interface LineEventSource {
    type?: 'user' | 'group' | 'room'
    userId?: string
    groupId?: string
    roomId?: string
}

interface LineInboundMessage {
    id?: string
    type?: string
    text?: string
    fileName?: string
    fileSize?: number
    duration?: number
    quoteToken?: string
    quotedMessageId?: string
    mention?: { mentionees?: LineMentionee[] }
}

interface LineMentionee {
    type?: 'user' | 'all'
    userId?: string
    isSelf?: boolean
}

interface LineTextMessageObject {
    type: 'text'
    text: string
    quoteToken?: string
}

interface LineBotInfo {
    userId?: string
    basicId?: string
    displayName?: string
    premiumId?: string
}

interface LineWebhookEndpointInfo {
    endpoint?: string
    active?: boolean
}

interface LineErrorEnvelope {
    message?: string
    details?: Array<{ property?: string; message?: string }>
}

@Injectable()
export class LineChannelProvider implements ChannelProvider {
    readonly name = 'line' as const
    private readonly logger = new Logger(LineChannelProvider.name)
    // Display names are stable and the lookup costs an API call per unknown
    // sender, so they are memoized per channel for the process lifetime.
    private readonly nameCache = new Map<string, string>()

    validateConfig(config: unknown): LineChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botUserId: trimmedOrNull(c.botUserId),
            basicId: trimmedOrNull(c.basicId),
            botDisplayName: trimmedOrNull(c.botDisplayName),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            allowedChatIds: stringList(c.allowedChatIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            // LINE has no message-edit API, so a streaming preview can never
            // land: every mode collapses to the terminal reply.
            progressMode: 'final',
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(credentials: unknown): LineChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const channelSecret =
            typeof c.channelSecret === 'string' ? c.channelSecret.trim() : ''
        const channelAccessToken =
            typeof c.channelAccessToken === 'string'
                ? c.channelAccessToken.trim()
                : ''
        if (!channelSecret)
            throw new BadRequestException(
                'credentials.channelSecret is required'
            )
        if (!channelAccessToken)
            throw new BadRequestException(
                'credentials.channelAccessToken is required'
            )
        return { channelSecret, channelAccessToken }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult> {
        const credentials = ctx.credentials as LineChannelCredentials | null
        if (!credentials?.channelAccessToken)
            return { ok: false, message: 'channelAccessToken missing' }
        const config = ctx.config as LineChannelConfig
        const info = await this.callApi<LineBotInfo>(
            credentials.channelAccessToken,
            'bot.info',
            'GET',
            '/v2/bot/info'
        )
        await this.callApi(
            credentials.channelAccessToken,
            'webhook.endpoint.set',
            'PUT',
            '/v2/bot/channel/webhook/endpoint',
            { endpoint: inboundUrl }
        )
        const endpoint = await this.callApi<LineWebhookEndpointInfo>(
            credentials.channelAccessToken,
            'webhook.endpoint.get',
            'GET',
            '/v2/bot/channel/webhook/endpoint'
        ).catch(() => null)
        let message = `webhook set for ${info.displayName ?? info.basicId ?? 'the LINE Official Account'}`
        // "Use webhook" is a console-only switch with no API, so a channel can
        // be fully registered here and still receive nothing.
        if (endpoint && endpoint.active === false)
            message +=
                '\n⚠ "Use webhook" is off in the LINE Developers console — turn it on under Messaging API, or no message will reach this channel'
        return {
            ok: true,
            activate: true,
            configPatch: {
                ...config,
                botUserId: info.userId ?? config.botUserId ?? null,
                basicId: info.basicId ?? config.basicId ?? null,
                botDisplayName:
                    info.displayName ?? config.botDisplayName ?? null
            },
            message
        }
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as LineChannelCredentials | null
        const secret = credentials?.channelSecret
        if (!secret) return { ok: false, reason: 'channel_secret_missing' }
        const provided = lowercaseHeaders(req.headers)['x-line-signature']
        if (!provided) return { ok: false, reason: 'missing_signature_header' }
        const rawBody =
            req.rawBody ??
            (typeof req.body === 'string'
                ? req.body
                : JSON.stringify(req.body ?? {}))
        const expected = createHmac('sha256', secret)
            .update(rawBody)
            .digest('base64')
        const a = Buffer.from(expected)
        const b = Buffer.from(provided)
        if (a.length !== b.length || !timingSafeEqual(a, b))
            return { ok: false, reason: 'signature_mismatch' }
        // The console's "Verify" button posts a signed body with no events and
        // expects a 200; answering it is what proves the endpoint reachable.
        const body = (req.body ?? {}) as LineWebhookBody
        if (!body.events || body.events.length === 0)
            return { ok: true, challengeResponse: { status: 200, body: {} } }
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const body = (req.body ?? {}) as LineWebhookBody
        const events = body.events ?? []
        const index = events.findIndex((e) => e.type === 'message')
        if (index === -1)
            throw new UnsupportedEventError(
                events[0]?.type ? `line_${events[0].type}` : 'no_message_event'
            )
        // LINE may batch events into one delivery. Only the first message is
        // turned into an inbound event — the controller's dedup key is
        // per-request, so processing the rest here would give them no dedup of
        // their own. Batches are rare in practice; a dropped one is logged.
        if (events.length > 1)
            this.logger.warn(
                `line webhook batch of ${events.length} events for channel=${ctx.channel.id}: only the first message event is processed`
            )
        const event = events[index]
        const message = event.message ?? {}
        const source = event.source ?? {}
        const chatType: 'private' | 'group' =
            source.type === 'user' ? 'private' : 'group'
        const chatId =
            source.type === 'user'
                ? (source.userId ?? '')
                : source.type === 'group'
                  ? (source.groupId ?? '')
                  : (source.roomId ?? '')
        if (!chatId) throw new BadRequestException('line event missing source id')
        const senderId = source.userId ?? ''
        if (!senderId)
            // Every event LINE sends from a user carries userId; a message
            // without one cannot be attributed, gated or replied to by user.
            throw new UnsupportedEventError('line_message_without_sender')
        const attachment = lineAttachmentFromMessage(message)
        const text = message.type === 'text' ? (message.text ?? '') : ''
        if (!text.trim() && !attachment)
            throw new UnsupportedEventError(
                `line_${message.type ?? 'unknown'}_message`
            )
        return {
            providerEventId: `line-${event.webhookEventId ?? message.id ?? ''}`,
            chatId,
            chatType,
            senderId,
            senderName: null,
            text,
            ...(attachment ? { attachments: [attachment] } : {}),
            threadId: null,
            isMention:
                chatType === 'private' ? true : mentionsBot(message.mention),
            messageId: message.id ?? null,
            replyToMessageId: message.quotedMessageId ?? null,
            // Answering with a quote needs the inbound quoteToken, not a
            // message id. DMs skip it: quoting the only other participant is
            // pure noise.
            replyTargetId:
                chatType === 'group' ? (message.quoteToken ?? null) : null,
            raw: event
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: LineChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        if (event.chatType === 'private')
            return {
                scopeKey: `line:${event.chatId}:${event.senderId}`,
                scopeName: event.senderName ?? null
            }
        if (config.shareSessionInChannel)
            return { scopeKey: `line:${event.chatId}`, scopeName: null }
        return {
            scopeKey: `line:${event.chatId}:${event.senderId}`,
            scopeName: event.senderName ?? null
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: LineChannelConfig
    ): InboundActorPolicy {
        const allowedUserIds = config.allowedUserIds ?? []
        const operatorUserIds = config.operatorUserIds ?? []
        const allowedChatIds = config.allowedChatIds ?? []
        const operator = operatorUserIds.includes(event.senderId)
        if (
            event.chatType === 'group' &&
            allowedChatIds.length > 0 &&
            !allowedChatIds.includes(event.chatId)
        )
            return { allowed: false, reason: 'chat_not_allowed', operator }
        const allowed =
            allowedUserIds.length === 0 ||
            allowedUserIds.includes(event.senderId) ||
            operator
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    async resolveSenderName(
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<string | null> {
        const cacheKey = `${ctx.channel.id}:${event.senderId}`
        const cached = this.nameCache.get(cacheKey)
        if (cached !== undefined) return cached
        const credentials = ctx.credentials as LineChannelCredentials | null
        if (!credentials?.channelAccessToken) return null
        // A group member's profile is only readable through the group-scoped
        // endpoint unless they added the account as a friend, so try that
        // first and fall back to the global profile.
        const paths =
            event.chatType === 'group'
                ? [
                      `${groupScopePath(event.chatId)}/member/${encodeURIComponent(event.senderId)}`,
                      `/v2/bot/profile/${encodeURIComponent(event.senderId)}`
                  ]
                : [`/v2/bot/profile/${encodeURIComponent(event.senderId)}`]
        for (const path of paths) {
            try {
                const profile = await this.callApi<{ displayName?: string }>(
                    credentials.channelAccessToken,
                    'profile.get',
                    'GET',
                    path
                )
                const name = profile.displayName?.trim()
                if (name) {
                    if (this.nameCache.size >= NAME_CACHE_MAX)
                        this.nameCache.clear()
                    this.nameCache.set(cacheKey, name)
                    return name
                }
            } catch {
                continue
            }
        }
        return null
    }

    // LINE's loading animation is a one-on-one affordance: the API rejects a
    // group or room id outright, so group turns simply show nothing.
    async startTyping(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<() => void> {
        const credentials = this.requireCredentials(ctx)
        const chatId = lineChatIdFromScopeKey(scopeKey)
        if (!chatId.startsWith('U')) return () => {}
        let warned = false
        const fire = (): void => {
            void this.callApi(
                credentials.channelAccessToken,
                'chat.loading.start',
                'POST',
                '/v2/bot/chat/loading/start',
                { chatId, loadingSeconds: LOADING_SECONDS }
            ).catch((err) => {
                if (warned) return
                warned = true
                this.logger.warn(
                    `line loading animation failed channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            })
        }
        fire()
        const interval = setInterval(fire, LOADING_REFRESH_MS)
        interval.unref?.()
        let stopped = false
        const stop = (): void => {
            if (stopped) return
            stopped = true
            clearInterval(interval)
            clearTimeout(cap)
        }
        const cap = setTimeout(stop, LOADING_MAX_MS)
        cap.unref?.()
        return stop
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }> {
        return this.push(
            ctx,
            lineChatIdFromScopeKey(scopeKey),
            text,
            opts?.replyToProviderMessageId ?? null
        )
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        // A LINE reply quote is addressed by quoteToken, which only exists on
        // an inbound message the bot just received — it cannot be recovered
        // from a stored message id, so a reply target has no meaning here.
        if (target.kind === 'reply')
            throw new BadRequestException(
                'line channel cannot reply to a specific message — send to the chat or user instead'
            )
        const chatId = target.kind === 'chat' ? target.chatId : target.userId
        return this.push(ctx, chatId, text, null)
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const messageId = parseLineContentUrl(attachment.url)
        const credentials = this.requireCredentials(ctx)
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            LINE_DOWNLOAD_TIMEOUT_MS
        )
        try {
            const response = await fetch(
                `${LINE_DATA_API_BASE}/v2/bot/message/${encodeURIComponent(messageId)}/content`,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${credentials.channelAccessToken}`
                    },
                    signal: controller.signal
                }
            )
            if (!response.ok)
                throw new Error(
                    `line content download failed: http ${response.status}`
                )
            const bytes = await readCappedBody(
                response,
                Math.min(opts.maxBytes, LINE_MAX_DOWNLOAD_BYTES)
            )
            return {
                name: attachment.name,
                contentType:
                    response.headers.get('content-type')?.split(';')[0]?.trim() ||
                    attachment.contentType ||
                    'application/octet-stream',
                bytes
            }
        } finally {
            clearTimeout(timer)
        }
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as LineChannelCredentials | null
        if (!credentials?.channelAccessToken)
            return { ok: false, message: '✗ channelAccessToken missing' }
        if (!credentials.channelSecret)
            return { ok: false, message: '✗ channelSecret missing' }
        const lines: string[] = []
        let ok = true
        try {
            const info = await this.callApi<LineBotInfo>(
                credentials.channelAccessToken,
                'bot.info',
                'GET',
                '/v2/bot/info'
            )
            lines.push(
                `✓ bot identity: ${info.displayName ?? info.userId ?? 'unknown'}${info.basicId ? ` (${info.basicId})` : ''}`
            )
        } catch (err) {
            return {
                ok: false,
                message: `✗ bot info failed: ${(err as Error).message}`
            }
        }
        try {
            const endpoint = await this.callApi<LineWebhookEndpointInfo>(
                credentials.channelAccessToken,
                'webhook.endpoint.get',
                'GET',
                '/v2/bot/channel/webhook/endpoint'
            )
            const expectedSuffix = `/api/channels/hooks/line/${ctx.channel.id}`
            if (endpoint.endpoint?.endsWith(expectedSuffix))
                lines.push('✓ webhook URL is set')
            else {
                ok = false
                lines.push(
                    `✗ webhook URL does not match — expected suffix ${expectedSuffix}, got ${endpoint.endpoint || '(none)'}`
                )
            }
            if (endpoint.active === false) {
                ok = false
                lines.push(
                    '✗ "Use webhook" is off — turn it on in the LINE Developers console under Messaging API'
                )
            } else if (endpoint.active === true) {
                lines.push('✓ "Use webhook" is on')
            }
        } catch (err) {
            ok = false
            lines.push(
                `✗ webhook endpoint check failed: ${(err as Error).message}`
            )
        }
        return { ok, message: lines.join('\n') }
    }

    private async push(
        ctx: ChannelContext,
        to: string,
        text: string,
        quoteToken: string | null
    ): Promise<{ providerMessageId?: string }> {
        const credentials = this.requireCredentials(ctx)
        const chunks = chunkText(
            markdownToLinePlainText(text),
            MAX_MESSAGE_LEN
        ).filter((chunk) => chunk.length > 0)
        if (chunks.length === 0) return {}
        let lastId: string | undefined
        for (let i = 0; i < chunks.length; i += MAX_MESSAGES_PER_PUSH) {
            const batch = chunks
                .slice(i, i + MAX_MESSAGES_PER_PUSH)
                .map((chunk, index): LineTextMessageObject => ({
                    type: 'text',
                    text: chunk,
                    // Only the first message of the reply quotes the trigger;
                    // repeating it on every chunk reads as spam.
                    ...(i === 0 && index === 0 && quoteToken
                        ? { quoteToken }
                        : {})
                }))
            const res = await this.callApi<{
                sentMessages?: Array<{ id?: string }>
            }>(
                credentials.channelAccessToken,
                'message.push',
                'POST',
                '/v2/bot/message/push',
                { to, messages: batch }
            )
            const sent = res.sentMessages ?? []
            lastId = sent[sent.length - 1]?.id ?? lastId
        }
        return { providerMessageId: lastId }
    }

    private requireCredentials(ctx: ChannelContext): LineChannelCredentials {
        const credentials = ctx.credentials as LineChannelCredentials | null
        if (!credentials?.channelAccessToken)
            throw new BadRequestException('line channelAccessToken missing')
        return credentials
    }

    private async callApi<T = Record<string, unknown>>(
        accessToken: string,
        operation: string,
        method: 'GET' | 'POST' | 'PUT',
        path: string,
        body?: Record<string, unknown>
    ): Promise<T> {
        const res: ChannelProviderJsonResponse<T & LineErrorEnvelope> =
            await channelProviderJsonRequest<T & LineErrorEnvelope>({
                provider: 'line',
                operation,
                url: `${LINE_API_BASE}${path}`,
                init: {
                    method,
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        ...(body
                            ? { 'Content-Type': 'application/json' }
                            : {})
                    },
                    ...(body ? { body: JSON.stringify(body) } : {})
                }
            })
        if (!res.ok) {
            const detail =
                res.json?.details
                    ?.map((d) =>
                        [d.property, d.message].filter(Boolean).join(': ')
                    )
                    .join('; ') || ''
            const description = [res.json?.message, detail]
                .filter((part) => part && part.length > 0)
                .join(' — ')
            const message = `line ${operation} failed: ${res.status} ${description || res.text.slice(0, 300)}`
            const kind = classifyLineFailure(res.status, description)
            if (kind === null) throw new Error(message)
            throw new ChannelSendError(kind, message, {
                retryAfterMs: kind === 'rate_limited' ? res.retryAfterMs : null
            })
        }
        return (res.json ?? {}) as T
    }
}

const trimmedOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const stringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? Array.from(
              new Set(
                  value
                      .filter(
                          (item): item is string =>
                              typeof item === 'string' &&
                              item.trim().length > 0
                      )
                      .map((item) => item.trim())
              )
          )
        : []

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers))
        out[key.toLowerCase()] = value
    return out
}

// LINE resolves the bot's own mention for us, so no display-name matching is
// needed: an @all broadcast is not a mention of this bot.
const mentionsBot = (mention: LineInboundMessage['mention']): boolean =>
    (mention?.mentionees ?? []).some((m) => m.isSelf === true)

const groupScopePath = (chatId: string): string =>
    chatId.startsWith('R')
        ? `/v2/bot/room/${encodeURIComponent(chatId)}`
        : `/v2/bot/group/${encodeURIComponent(chatId)}`

const lineChatIdFromScopeKey = (scopeKey: string): string => {
    const segments = scopeKey.split(':')
    if (segments.length < 2 || !segments[1])
        throw new Error(`invalid scopeKey ${scopeKey}`)
    return segments[1]
}

// LINE never exposes a URL for inbound media: the bytes come from the content
// endpoint keyed by message id, so the descriptor carries a pseudo-URL that
// downloadAttachment resolves. The bridge treats it as opaque.
const lineAttachmentFromMessage = (
    message: LineInboundMessage
): NormalizedInboundAttachment | null => {
    const id = message.id
    if (!id) return null
    switch (message.type) {
        case 'image':
            return {
                url: `${LINE_CONTENT_PREFIX}${id}`,
                name: `image-${id}.jpg`,
                contentType: 'image/jpeg',
                size: null
            }
        case 'video':
            return {
                url: `${LINE_CONTENT_PREFIX}${id}`,
                name: `video-${id}.mp4`,
                contentType: 'video/mp4',
                size: null
            }
        case 'audio':
            return {
                url: `${LINE_CONTENT_PREFIX}${id}`,
                name: `audio-${id}.m4a`,
                contentType: 'audio/mp4',
                size: null
            }
        case 'file':
            return {
                url: `${LINE_CONTENT_PREFIX}${id}`,
                name: message.fileName ?? `file-${id}`,
                contentType: 'application/octet-stream',
                size: message.fileSize ?? null
            }
        default:
            return null
    }
}

const parseLineContentUrl = (url: string): string => {
    if (!url.startsWith(LINE_CONTENT_PREFIX))
        throw new Error('line attachment url is not a line-content url')
    const messageId = url.slice(LINE_CONTENT_PREFIX.length)
    if (!messageId) throw new Error('line attachment message id is empty')
    return messageId
}

// Positive identification only: anything not listed stays a plain Error and
// keeps the ladder-retry path.
const classifyLineFailure = (
    status: number,
    description: string
): ChannelSendErrorKind | null => {
    if (status === 429) return 'rate_limited'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 400) {
        // LINE reports an unreachable recipient as a complaint about the `to`
        // property ("The property, to, may not be used"). The boundaries
        // matter: an unanchored `to` also matches "Invalid reply token",
        // which is a request-shape problem, not a missing recipient.
        if (/may not be used|\binvalid\b[^.]*\b(?:to|recipient|user)\b/i.test(description))
            return 'not_found'
        return 'bad_format'
    }
    return null
}

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > maxBytes)
            throw new Error(`line content exceeds ${maxBytes} bytes`)
        return bytes
    }
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new Error(`line content exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}
