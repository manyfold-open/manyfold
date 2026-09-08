import type {
    ChannelTestResult,
    IMessageChannelConfig,
    IMessageChannelCredentials
} from '@manyfold/shared'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
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
    type OutboundAttachment,
    type RegistrationResult,
    type SignatureCheck
} from '../channel-provider'
import { ChannelSendError } from '../channel-send-error'
import { parseResetOnIdleMins } from '../config-helpers'
import {
    bluebubblesJson,
    normalizeServerUrl,
    probeServerInfo,
    redactHandle,
    type BlueBubblesChatRow,
    type BlueBubblesSentMessage,
    type BlueBubblesWebhookRow
} from './imessage-bluebubbles'
import {
    compileWakeWords,
    markdownToIMessagePlainText,
    splitIMessageBubbles,
    stripLeadingWakeWord
} from './imessage-format'

// Messages has no documented per-bubble cap; this is a readability bound, well
// under anything the bridge would hand us in one reply.
const MAX_BUBBLE_LEN = 4000
const IMESSAGE_ATTACHMENT_PREFIX = 'imessage-attachment:'
const IMESSAGE_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
const IMESSAGE_DOWNLOAD_TIMEOUT_MS = 60_000
const CHAT_QUERY_PAGE = 100
const CHAT_QUERY_MAX_PAGES = 20
const CHAT_CACHE_MAX = 4096
// Tapbacks arrive as ordinary messages carrying an association type: 2000-2005
// add a reaction, 3000-3005 remove one. Neither is something to answer.
const TAPBACK_MIN = 2000
const TAPBACK_MAX = 3005
// iMessage marks an attachment's position in the text with U+FFFC.
const OBJECT_REPLACEMENT_RE = /￼/g

interface BlueBubblesInboundBody {
    type?: string
    event?: string
    data?: unknown
    message?: unknown
    chatGuid?: string
}

interface BlueBubblesMessageRecord {
    guid?: string
    messageGuid?: string
    id?: string | number
    text?: string
    message?: string
    body?: string
    isFromMe?: boolean
    fromMe?: boolean
    is_from_me?: boolean
    associatedMessageType?: number
    associatedMessageGuid?: string
    threadOriginatorGuid?: string
    isGroup?: boolean
    chatGuid?: string
    chat_guid?: string
    chatIdentifier?: string
    identifier?: string
    handle?: { address?: string }
    sender?: string
    from?: string
    address?: string
    attachments?: BlueBubblesAttachment[]
    chats?: BlueBubblesChatRow[]
}

interface BlueBubblesAttachment {
    guid?: string
    transferName?: string
    mimeType?: string
    totalBytes?: number
}

@Injectable()
export class IMessageChannelProvider implements ChannelProvider {
    readonly name = 'imessage' as const
    private readonly logger = new Logger(IMessageChannelProvider.name)
    // Resolving a bare handle to a chat GUID costs a paged scan of every chat
    // on the Mac, and the mapping is stable, so it is memoized per channel.
    private readonly chatGuidCache = new Map<string, string>()

    validateConfig(
        config: unknown,
        opts?: { strict?: boolean }
    ): IMessageChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        let serverUrl: string
        try {
            serverUrl = normalizeServerUrl(c.serverUrl)
        } catch (err) {
            throw new BadRequestException((err as Error).message)
        }
        const wakeWords = stringList(c.wakeWords)
        const mentionOnly = c.mentionOnly !== false
        if (opts?.strict && mentionOnly && wakeWords.length === 0)
            // Without a wake word a mention-gated channel answers nothing in
            // any group and gives the operator no signal about why.
            throw new BadRequestException(
                'config.wakeWords must list at least one word when mentionOnly is on — iMessage has no bot identity to @-mention'
            )
        return {
            serverUrl,
            webhookId: trimmedOrNull(c.webhookId),
            serverVersion: trimmedOrNull(c.serverVersion),
            privateApi: typeof c.privateApi === 'boolean' ? c.privateApi : null,
            helperConnected:
                typeof c.helperConnected === 'boolean'
                    ? c.helperConnected
                    : null,
            allowedUserIds: uniqueHandles(c.allowedUserIds),
            operatorUserIds: uniqueHandles(c.operatorUserIds),
            allowedChatIds: stringList(c.allowedChatIds),
            wakeWords,
            mentionOnly,
            shareSessionInChannel: c.shareSessionInChannel === true,
            // Messages cannot edit a sent bubble, so a streaming preview can
            // never land: every mode collapses to the terminal reply.
            progressMode: 'final',
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(
        credentials: unknown
    ): IMessageChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const serverPassword =
            typeof c.serverPassword === 'string' ? c.serverPassword.trim() : ''
        if (!serverPassword)
            throw new BadRequestException(
                'credentials.serverPassword is required'
            )
        return {
            serverPassword,
            webhookSecret: trimmedOrNull(c.webhookSecret)
        }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult> {
        const credentials = ctx.credentials as IMessageChannelCredentials | null
        if (!credentials?.serverPassword)
            return { ok: false, message: '✗ serverPassword missing' }
        const config = ctx.config as IMessageChannelConfig
        const { serverUrl } = config
        const password = credentials.serverPassword
        try {
            await bluebubblesJson<unknown>({
                serverUrl,
                password,
                operation: 'ping',
                method: 'GET',
                path: '/api/v1/ping'
            })
        } catch (err) {
            return {
                ok: false,
                message: `✗ cannot reach the BlueBubbles server at ${serverUrl}: ${(err as Error).message}. It has to be reachable from the public internet — expose it with a Cloudflare Tunnel, ngrok or Tailscale Funnel.`
            }
        }
        const info = await probeServerInfo(serverUrl, password)
        // Reused rather than re-minted: the URL BlueBubbles already holds stays
        // valid, so a re-register cannot orphan it and silently deafen the
        // channel. Rotation is by recreating the channel.
        const secret =
            credentials.webhookSecret ?? randomBytes(32).toString('base64url')
        const suffix = `/api/channels/hooks/imessage/${ctx.channel.id}`
        const existing = await this.listWebhooks(serverUrl, password)
        for (const row of existing)
            if (webhookMatchesChannel(row.url, suffix) && row.id !== undefined)
                await this.deleteWebhook(serverUrl, password, row.id)
        const created = await bluebubblesJson<BlueBubblesWebhookRow>({
            serverUrl,
            password,
            operation: 'webhook.create',
            method: 'POST',
            path: '/api/v1/webhook',
            body: {
                url: `${inboundUrl}?secret=${encodeURIComponent(secret)}`,
                // updated-message repeats the same message GUID, which the
                // inbound dedup index drops anyway, so subscribing to it only
                // buys a request per delivered/read receipt.
                events: ['new-message']
            }
        })
        let message = `✓ webhook registered on BlueBubbles ${info.serverVersion ?? 'server'}`
        if (!info.privateApi || !info.helperConnected)
            message +=
                '\n⚠ the BlueBubbles Private API helper is not connected — starting a new conversation from a phone number that has never messaged this Mac will not work. Everything else (send, receive, attachments) is unaffected.'
        return {
            ok: true,
            activate: true,
            configPatch: {
                ...config,
                webhookId:
                    created.id !== undefined ? String(created.id) : null,
                serverVersion: info.serverVersion,
                privateApi: info.privateApi,
                helperConnected: info.helperConnected
            },
            // runRegister replaces the whole credentials blob, so the password
            // has to be restated or it is destroyed.
            credentialsPatch: { serverPassword: password, webhookSecret: secret },
            message
        }
    }

    async unregister(ctx: ChannelContext): Promise<void> {
        const credentials = ctx.credentials as IMessageChannelCredentials | null
        if (!credentials?.serverPassword) return
        const config = ctx.config as IMessageChannelConfig
        const { serverUrl } = config
        const password = credentials.serverPassword
        const suffix = `/api/channels/hooks/imessage/${ctx.channel.id}`
        if (config.webhookId)
            await this.deleteWebhook(serverUrl, password, config.webhookId)
        const remaining = await this.listWebhooks(serverUrl, password)
        for (const row of remaining)
            if (webhookMatchesChannel(row.url, suffix) && row.id !== undefined)
                await this.deleteWebhook(serverUrl, password, row.id)
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as IMessageChannelCredentials | null
        const secret = credentials?.webhookSecret
        if (!secret) return { ok: false, reason: 'webhook_secret_missing' }
        const provided =
            firstQueryValue(req.query?.secret) ??
            lowercaseHeaders(req.headers)['x-manyfold-webhook-secret'] ??
            null
        if (!provided) return { ok: false, reason: 'missing_secret' }
        // Hashed before comparison so timingSafeEqual always sees equal-length
        // buffers: it throws on a length mismatch, which would both crash the
        // request and leak the expected length.
        const a = createHash('sha256').update(secret).digest()
        const b = createHash('sha256').update(provided).digest()
        if (!timingSafeEqual(a, b)) return { ok: false, reason: 'secret_mismatch' }
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const body = decodeBody(req.body)
        const type = body.type ?? body.event ?? ''
        if (type !== 'new-message')
            throw new UnsupportedEventError(`imessage_${type || 'unknown'}`)
        const record = extractRecord(body)
        if (record.isFromMe === true || record.fromMe === true || record.is_from_me === true)
            // An echo of our own reply arrives on every send; recording a
            // dropped row for each would double the delivery table.
            throw new UnsupportedEventError('imessage_from_me', { silent: true })
        const association = record.associatedMessageType
        if (
            typeof association === 'number' &&
            association >= TAPBACK_MIN &&
            association <= TAPBACK_MAX
        )
            throw new UnsupportedEventError('imessage_tapback')
        const guid = record.guid ?? record.messageGuid ?? null
        if (!guid)
            // Without the Apple GUID there is no durable dedup key, and
            // BlueBubbles retries nothing — a synthetic id would silently turn
            // a redelivery into a second billed turn.
            throw new UnsupportedEventError('imessage_message_without_guid')
        const chat = record.chats?.[0]
        const chatId =
            record.chatGuid ??
            body.chatGuid ??
            record.chat_guid ??
            chat?.guid ??
            record.chatIdentifier ??
            record.identifier ??
            ''
        if (!chatId)
            throw new UnsupportedEventError('imessage_message_without_chat')
        const senderId =
            record.handle?.address ??
            record.sender ??
            record.from ??
            record.address ??
            ''
        if (!senderId)
            // An unattributable message cannot be gated by allowlist or
            // answered by handle.
            throw new UnsupportedEventError('imessage_message_without_sender')
        const isGroup =
            record.isGroup === true ||
            chatId.includes(';+;') ||
            (chat?.participants?.length ?? 0) > 1
        const chatType: 'private' | 'group' = isGroup ? 'group' : 'private'
        const rawText = (record.text ?? record.message ?? record.body ?? '')
            .replace(OBJECT_REPLACEMENT_RE, '')
            .trim()
        const attachments = (record.attachments ?? [])
            .filter((att) => typeof att.guid === 'string' && att.guid.length > 0)
            .map(
                (att): NormalizedInboundAttachment => ({
                    url: `${IMESSAGE_ATTACHMENT_PREFIX}${att.guid}`,
                    name: att.transferName ?? `file-${att.guid}`,
                    contentType: att.mimeType ?? 'application/octet-stream',
                    size: att.totalBytes ?? null
                })
            )
        if (!rawText && attachments.length === 0)
            throw new UnsupportedEventError('imessage_empty_message')
        let text = rawText
        let isMention = true
        if (chatType === 'group') {
            const config = ctx.config as IMessageChannelConfig
            const re = compileWakeWords(config.wakeWords ?? [])
            isMention = re !== null && re.test(rawText)
            if (isMention && re) text = stripLeadingWakeWord(rawText, re)
        }
        return {
            providerEventId: `imessage-${guid}`,
            chatId,
            chatType,
            senderId,
            senderName: chat?.displayName ?? senderId,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            threadId: null,
            isMention,
            messageId: guid,
            replyToMessageId: record.threadOriginatorGuid ?? null,
            replyTargetId: null,
            raw: body
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: IMessageChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        if (event.chatType === 'private')
            return {
                scopeKey: `imessage:dm:${enc(event.chatId)}`,
                scopeName: event.senderName ?? event.chatId
            }
        const base = `imessage:group:${enc(event.chatId)}`
        return {
            scopeKey: config.shareSessionInChannel
                ? base
                : `${base}:${enc(event.senderId)}`,
            scopeName: event.senderName ?? event.chatId
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: IMessageChannelConfig
    ): InboundActorPolicy {
        const sender = normalizeHandle(event.senderId)
        const allowedUserIds = config.allowedUserIds ?? []
        const operatorUserIds = config.operatorUserIds ?? []
        const allowedChatIds = config.allowedChatIds ?? []
        const operator = operatorUserIds.includes(sender)
        if (
            event.chatType === 'group' &&
            allowedChatIds.length > 0 &&
            !allowedChatIds.includes(event.chatId)
        )
            // Deliberately not overridden by operator status: a chat block is
            // about where the agent may speak, not who may drive it.
            return { allowed: false, reason: 'chat_not_allowed', operator }
        const allowed =
            allowedUserIds.length === 0 ||
            allowedUserIds.includes(sender) ||
            operator
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        return this.sendToChat(ctx, chatGuidFromScopeKey(scopeKey), text)
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        if (target.kind === 'reply')
            // A message GUID does not identify the chat it belongs to, and
            // BlueBubbles exposes no lookup from one to the other.
            throw new BadRequestException(
                'imessage channel cannot reply to a specific message — send to the chat or handle instead'
            )
        if (target.kind === 'chat')
            return this.sendToChat(ctx, target.chatId, text)
        const chatGuid = await this.resolveChatGuid(ctx, target.userId)
        if (chatGuid) return this.sendToChat(ctx, chatGuid, text)
        return this.startChat(ctx, target.userId, text)
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        return this.uploadAttachments(
            ctx,
            chatGuidFromScopeKey(scopeKey),
            files
        )
    }

    async sendDirectAttachments(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        if (target.kind === 'reply')
            throw new BadRequestException(
                'imessage channel cannot reply to a specific message — send to the chat or handle instead'
            )
        if (target.kind === 'chat')
            return this.uploadAttachments(ctx, target.chatId, files)
        const chatGuid = await this.resolveChatGuid(ctx, target.userId)
        if (!chatGuid)
            throw new ChannelSendError(
                'not_found',
                `no existing iMessage conversation with ${redactHandle(target.userId)} — send a text first to start one`
            )
        return this.uploadAttachments(ctx, chatGuid, files)
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        if (!attachment.url.startsWith(IMESSAGE_ATTACHMENT_PREFIX))
            throw new Error('imessage attachment url is not an imessage-attachment url')
        const guid = attachment.url.slice(IMESSAGE_ATTACHMENT_PREFIX.length)
        if (!guid) throw new Error('imessage attachment guid is empty')
        const { config, credentials } = this.require(ctx)
        const url = `${config.serverUrl}/api/v1/attachment/${encodeURIComponent(guid)}/download?password=${encodeURIComponent(credentials.serverPassword)}`
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            IMESSAGE_DOWNLOAD_TIMEOUT_MS
        )
        try {
            const response = await fetch(url, {
                method: 'GET',
                signal: controller.signal
            })
            if (!response.ok)
                throw new Error(
                    `imessage attachment download failed: http ${response.status}`
                )
            const bytes = await readCappedBody(
                response,
                Math.min(opts.maxBytes, IMESSAGE_MAX_DOWNLOAD_BYTES)
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
        const credentials = ctx.credentials as IMessageChannelCredentials | null
        if (!credentials?.serverPassword)
            return { ok: false, message: '✗ serverPassword missing' }
        const config = ctx.config as IMessageChannelConfig
        const { serverUrl } = config
        const password = credentials.serverPassword
        const lines: string[] = []
        let ok = true
        try {
            await bluebubblesJson<unknown>({
                serverUrl,
                password,
                operation: 'ping',
                method: 'GET',
                path: '/api/v1/ping'
            })
            lines.push(`✓ BlueBubbles server reachable at ${serverUrl}`)
        } catch (err) {
            return {
                ok: false,
                message: `✗ cannot reach the BlueBubbles server at ${serverUrl}: ${(err as Error).message}. It has to be reachable from the public internet — expose it with a Cloudflare Tunnel, ngrok or Tailscale Funnel.`
            }
        }
        try {
            const info = await probeServerInfo(serverUrl, password)
            lines.push(
                `✓ BlueBubbles ${info.serverVersion ?? 'unknown'}${info.osVersion ? ` on macOS ${info.osVersion}` : ''}`
            )
            lines.push(
                info.privateApi && info.helperConnected
                    ? '✓ Private API helper connected'
                    : '⚠ Private API helper not connected — starting a conversation with a handle that has never messaged this Mac is unavailable'
            )
        } catch (err) {
            ok = false
            lines.push(`✗ server info failed: ${(err as Error).message}`)
        }
        try {
            const suffix = `/api/channels/hooks/imessage/${ctx.channel.id}`
            const rows = await this.listWebhooks(serverUrl, password)
            const match = rows.find((row) =>
                webhookMatchesChannel(row.url, suffix)
            )
            if (!match) {
                ok = false
                lines.push(
                    '✗ no webhook registered for this channel — use Register'
                )
            } else if (
                webhookSecretOf(match.url) !== credentials.webhookSecret
            ) {
                ok = false
                lines.push(
                    '✗ the registered webhook carries a stale secret — use Register'
                )
            } else {
                lines.push('✓ webhook registered')
            }
        } catch (err) {
            ok = false
            lines.push(`✗ webhook check failed: ${(err as Error).message}`)
        }
        if (serverUrl.startsWith('http://'))
            lines.push(
                '⚠ serverUrl uses http:// — the server password and the webhook secret travel in cleartext query strings. Use a tunnel that terminates TLS.'
            )
        return { ok, message: lines.join('\n') }
    }

    private async sendToChat(
        ctx: ChannelContext,
        chatGuid: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const { config, credentials } = this.require(ctx)
        const bubbles = splitIMessageBubbles(
            markdownToIMessagePlainText(text),
            MAX_BUBBLE_LEN
        )
        if (bubbles.length === 0) return {}
        let lastId: string | undefined
        for (const bubble of bubbles) {
            const sent = await bluebubblesJson<BlueBubblesSentMessage>({
                serverUrl: config.serverUrl,
                password: credentials.serverPassword,
                operation: 'message.text',
                method: 'POST',
                path: '/api/v1/message/text',
                body: {
                    chatGuid,
                    tempGuid: `manyfold-${randomUUID()}`,
                    message: bubble
                }
            })
            lastId = sent.guid ?? lastId
        }
        return { providerMessageId: lastId }
    }

    private async startChat(
        ctx: ChannelContext,
        handle: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const { config, credentials } = this.require(ctx)
        if (!config.privateApi || !config.helperConnected)
            throw new ChannelSendError(
                'not_found',
                `no existing iMessage conversation with ${redactHandle(handle)}; starting one requires the BlueBubbles Private API helper`
            )
        const sent = await bluebubblesJson<BlueBubblesSentMessage>({
            serverUrl: config.serverUrl,
            password: credentials.serverPassword,
            operation: 'chat.new',
            method: 'POST',
            path: '/api/v1/chat/new',
            body: {
                addresses: [handle],
                message: markdownToIMessagePlainText(text),
                tempGuid: `manyfold-${randomUUID()}`
            }
        })
        return { providerMessageId: sent.guid }
    }

    private async uploadAttachments(
        ctx: ChannelContext,
        chatGuid: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const { config, credentials } = this.require(ctx)
        let lastId: string | undefined
        for (const file of files) {
            const form = new FormData()
            form.append('chatGuid', chatGuid)
            form.append('tempGuid', `manyfold-${randomUUID()}`)
            form.append('name', file.name)
            form.append(
                'attachment',
                new Blob([new Uint8Array(file.bytes)], {
                    type: file.contentType
                }),
                file.name
            )
            const sent = await bluebubblesJson<BlueBubblesSentMessage>({
                serverUrl: config.serverUrl,
                password: credentials.serverPassword,
                operation: 'message.attachment',
                method: 'POST',
                path: '/api/v1/message/attachment',
                form
            })
            lastId = sent.guid ?? lastId
        }
        return { providerMessageId: lastId }
    }

    // Matches chatIdentifier exactly and never falls back to participant
    // membership: a participant match would resolve a DM handle to some group
    // that contact happens to be in, leaking a private reply into it.
    private async resolveChatGuid(
        ctx: ChannelContext,
        target: string
    ): Promise<string | null> {
        if (target.includes(';')) return target
        const { config, credentials } = this.require(ctx)
        const wanted = normalizeHandle(target)
        const cacheKey = `${ctx.channel.id}:${wanted}`
        const cached = this.chatGuidCache.get(cacheKey)
        if (cached !== undefined) return cached
        for (let page = 0; page < CHAT_QUERY_MAX_PAGES; page++) {
            const rows = await bluebubblesJson<BlueBubblesChatRow[]>({
                serverUrl: config.serverUrl,
                password: credentials.serverPassword,
                operation: 'chat.query',
                method: 'POST',
                path: '/api/v1/chat/query',
                body: { limit: CHAT_QUERY_PAGE, offset: page * CHAT_QUERY_PAGE }
            })
            if (!Array.isArray(rows) || rows.length === 0) break
            for (const row of rows) {
                const identifier = row.chatIdentifier ?? ''
                if (!identifier || normalizeHandle(identifier) !== wanted)
                    continue
                const guid = row.guid ?? null
                if (!guid) continue
                if (this.chatGuidCache.size >= CHAT_CACHE_MAX)
                    this.chatGuidCache.clear()
                this.chatGuidCache.set(cacheKey, guid)
                return guid
            }
            if (rows.length < CHAT_QUERY_PAGE) break
        }
        return null
    }

    private async listWebhooks(
        serverUrl: string,
        password: string
    ): Promise<BlueBubblesWebhookRow[]> {
        const rows = await bluebubblesJson<BlueBubblesWebhookRow[]>({
            serverUrl,
            password,
            operation: 'webhook.list',
            method: 'GET',
            path: '/api/v1/webhook'
        })
        return Array.isArray(rows) ? rows : []
    }

    private async deleteWebhook(
        serverUrl: string,
        password: string,
        id: number | string
    ): Promise<void> {
        await bluebubblesJson<unknown>({
            serverUrl,
            password,
            operation: 'webhook.delete',
            method: 'DELETE',
            path: `/api/v1/webhook/${encodeURIComponent(String(id))}`
        }).catch((err) => {
            this.logger.warn(
                redactHandle(
                    `imessage webhook delete failed for ${id}: ${(err as Error).message}`
                )
            )
        })
    }

    private require(ctx: ChannelContext): {
        config: IMessageChannelConfig
        credentials: IMessageChannelCredentials
    } {
        const credentials = ctx.credentials as IMessageChannelCredentials | null
        if (!credentials?.serverPassword)
            throw new BadRequestException('imessage serverPassword missing')
        return { config: ctx.config as IMessageChannelConfig, credentials }
    }
}

const enc = encodeURIComponent

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

// A handle reaches Messages as '+1 (555) 555-0123', '+15555550123' or an email
// with any casing; allowlists have to compare equal across all of them.
const normalizeHandle = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.includes('@')) return trimmed.toLowerCase()
    const digits = trimmed.replace(/[^\d+]/g, '')
    return digits.length > 0 ? digits : trimmed.toLowerCase()
}

// Normalize before deduping: two spellings of one number are one entry, and
// deduping the raw strings first would keep both.
const uniqueHandles = (value: unknown): string[] =>
    Array.from(new Set(stringList(value).map(normalizeHandle)))

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers))
        out[key.toLowerCase()] = value
    return out
}

const firstQueryValue = (
    value: string | string[] | undefined
): string | null => {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
    return null
}

// BlueBubbles has shipped the message under `data`, as the first element of a
// `data` array, and under `message`; the form-encoded path also nests the whole
// JSON under a single field.
const decodeBody = (raw: unknown): BlueBubblesInboundBody => {
    if (typeof raw === 'string') return safeParse(raw)
    if (raw === null || typeof raw !== 'object') return {}
    const obj = raw as Record<string, unknown>
    for (const key of ['payload', 'data', 'message']) {
        const value = obj[key]
        if (typeof value === 'string' && value.trimStart().startsWith('{')) {
            const parsed = safeParse(value)
            if (parsed.type ?? parsed.event) return parsed
        }
    }
    return obj as BlueBubblesInboundBody
}

const safeParse = (text: string): BlueBubblesInboundBody => {
    try {
        const parsed = JSON.parse(text) as unknown
        return parsed !== null && typeof parsed === 'object'
            ? (parsed as BlueBubblesInboundBody)
            : {}
    } catch {
        return {}
    }
}

const extractRecord = (
    body: BlueBubblesInboundBody
): BlueBubblesMessageRecord => {
    const { data } = body
    if (Array.isArray(data)) {
        const first = data[0]
        if (first !== null && typeof first === 'object')
            return first as BlueBubblesMessageRecord
    }
    if (data !== null && typeof data === 'object')
        return data as BlueBubblesMessageRecord
    const { message } = body
    if (message !== null && typeof message === 'object')
        return message as BlueBubblesMessageRecord
    return body as BlueBubblesMessageRecord
}

const webhookMatchesChannel = (
    url: string | undefined,
    suffix: string
): boolean => {
    if (!url) return false
    try {
        return new URL(url).pathname.endsWith(suffix)
    } catch {
        return false
    }
}

const webhookSecretOf = (url: string | undefined): string | null => {
    if (!url) return null
    try {
        return new URL(url).searchParams.get('secret')
    } catch {
        return null
    }
}

const chatGuidFromScopeKey = (scopeKey: string): string => {
    const segments = scopeKey.split(':')
    if (segments.length < 3 || !segments[2])
        throw new Error(`invalid scopeKey ${scopeKey}`)
    return decodeURIComponent(segments[2])
}

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > maxBytes)
            throw new Error(`imessage attachment exceeds ${maxBytes} bytes`)
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
            throw new Error(`imessage attachment exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}
