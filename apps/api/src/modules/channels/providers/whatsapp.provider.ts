import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import type { WAMessage, WAMessageKey, WASocket } from 'baileys'
import type {
    ChannelTestResult,
    WhatsappChannelConfig
} from '@manyfold/shared'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHandle,
    type ChannelProvider,
    type ChannelSendTarget,
    type InboundActorPolicy,
    type InboundHandler,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type OutboundAttachment,
    type SignatureCheck,
    type StatusHandler
} from '../channel-provider'
import { ChannelsRepository } from '../channels.repository'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { parseProgressMode, parseResetOnIdleMins } from '../config-helpers'
import { chunkText } from '../text-chunk'
import {
    createWaSocket,
    createWhatsappAuthStore,
    deserializeWhatsappAuth,
    serializeWhatsappAuth,
    waCloseCode,
    WA_LOGGED_OUT,
    type WhatsappAuthSnapshot
} from './whatsapp-baileys'
import {
    decodeMediaDescriptor,
    downloadWhatsappMedia,
    encodeMediaDescriptor,
    whatsappMediaName,
    type WhatsappMediaKind
} from './whatsapp-media'

// WhatsApp accepts far longer bodies than this, but very long single bubbles
// render badly on phones and a failed send loses the whole thing.
const WHATSAPP_MAX_TEXT_LEN = 4000
const WHATSAPP_CHUNK_DELAY_MS = 600
const WHATSAPP_TYPING_REFRESH_MS = 8_000
const WHATSAPP_TYPING_MAX_MS = 10 * 60_000
// Reactions need the triggering message's full key (a group key carries the
// participant), which the scope key cannot encode. Bounded so a busy channel
// cannot grow this without limit.
const WHATSAPP_KEY_CACHE_MAX = 500
const WHATSAPP_LOGGED_OUT_MESSAGE =
    'whatsapp session logged out — delete this channel and scan the QR code again'
const WHATSAPP_NO_SOCKET_MESSAGE =
    'whatsapp connection is not established on this instance'
const WHATSAPP_INCOMPLETE_NOTICE = '⚠️ message truncated: send failed midway'

export interface WhatsappProviderState {
    v: 1
    authCiphertext: string
    keyVersion: number
    botJid?: string | null
    // Set when WhatsApp reported the linked device was removed. Reconnecting
    // with dead credentials only burns handshakes, so start() refuses instead.
    loggedOut?: boolean
}

const REACTION_EMOJI: Record<'working' | 'done' | 'failed', string> = {
    working: '👀',
    done: '✅',
    failed: '❌'
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })

const enc = (value: string): string => encodeURIComponent(value)

const optionalString = (value: unknown): string | null =>
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

export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')

const jidUserPart = (jid: string): string =>
    jid.split('@')[0]?.split(':')[0] ?? ''

// Operators type phone numbers; WhatsApp reports jids. Since the LID
// migration the same person can appear as <phone>@s.whatsapp.net or as
// <opaque>@lid, so a phone-shaped entry is compared on digits against
// phone-form jids only. A lid is opaque and could collide numerically with
// somebody's phone number, so it only ever matches literally.
export const whatsappIdentityMatches = (
    candidate: string,
    jid: string
): boolean => {
    const wanted = candidate.trim()
    if (!wanted || !jid) return false
    if (wanted === jid) return true
    const jidUser = jidUserPart(jid)
    if (!jidUser) return false
    const domain = jid.split('@')[1] ?? ''
    if (domain !== 's.whatsapp.net' && domain !== 'g.us') return false
    const wantedDomain = wanted.includes('@') ? wanted.split('@')[1] : null
    if (wantedDomain && wantedDomain !== domain) return false
    const wantedUser = jidUserPart(wanted).replace(/[\s()+-]/g, '')
    return wantedUser.length > 0 && wantedUser === jidUser
}

const matchesAny = (candidates: string[], jids: string[]): boolean =>
    candidates.some((candidate) =>
        jids.some((jid) => whatsappIdentityMatches(candidate, jid))
    )

const jidFromScopeKey = (scopeKey: string): string => {
    const parts = scopeKey.split(':')
    if (parts[0] !== 'whatsapp' || !parts[2])
        throw new BadRequestException(`invalid whatsapp scope key: ${scopeKey}`)
    return decodeURIComponent(parts[2])
}

// Phone numbers reach us with spaces, dashes and a leading +; WhatsApp wants
// bare digits. A value that already looks like a jid is passed through so
// group ids and lids survive.
export const toWhatsappJid = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.includes('@')) return trimmed
    const digits = trimmed.replace(/[^0-9]/g, '')
    if (!digits) throw new BadRequestException(`invalid whatsapp target: ${value}`)
    return `${digits}@s.whatsapp.net`
}

interface MediaExtract {
    kind: WhatsappMediaKind
    node: Record<string, unknown>
}

const MEDIA_FIELDS: Array<[string, WhatsappMediaKind]> = [
    ['imageMessage', 'image'],
    ['documentMessage', 'document'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio']
]

// A message wrapped in ephemeral/view-once/edit envelopes carries the real
// content one or two levels down; unwrapping keeps every downstream branch
// working on the plain content node.
const unwrapContent = (
    message: Record<string, unknown> | null | undefined
): Record<string, unknown> | null => {
    let current = message ?? null
    for (let depth = 0; current && depth < 4; depth += 1) {
        const next =
            (current.ephemeralMessage as { message?: Record<string, unknown> })
                ?.message ??
            (current.viewOnceMessage as { message?: Record<string, unknown> })
                ?.message ??
            (
                current.viewOnceMessageV2 as {
                    message?: Record<string, unknown>
                }
            )?.message ??
            (
                current.documentWithCaptionMessage as {
                    message?: Record<string, unknown>
                }
            )?.message
        if (!next) return current
        current = next
    }
    return current
}

const extractMedia = (
    content: Record<string, unknown>
): MediaExtract | null => {
    for (const [field, kind] of MEDIA_FIELDS) {
        const node = content[field]
        if (node && typeof node === 'object')
            return { kind, node: node as Record<string, unknown> }
    }
    return null
}

const extractText = (content: Record<string, unknown>): string => {
    if (typeof content.conversation === 'string') return content.conversation
    const extended = content.extendedTextMessage as { text?: unknown } | undefined
    if (typeof extended?.text === 'string') return extended.text
    for (const [field] of MEDIA_FIELDS) {
        const node = content[field] as { caption?: unknown } | undefined
        if (typeof node?.caption === 'string') return node.caption
    }
    return ''
}

const contextInfoOf = (
    content: Record<string, unknown>
): Record<string, unknown> | null => {
    const extended = content.extendedTextMessage as
        | { contextInfo?: Record<string, unknown> }
        | undefined
    if (extended?.contextInfo) return extended.contextInfo
    for (const [field] of MEDIA_FIELDS) {
        const node = content[field] as
            | { contextInfo?: Record<string, unknown> }
            | undefined
        if (node?.contextInfo) return node.contextInfo
    }
    return null
}

@Injectable()
export class WhatsappChannelProvider implements ChannelProvider {
    readonly name = 'whatsapp' as const
    private readonly logger = new Logger(WhatsappChannelProvider.name)
    // Live sockets by channel id. WhatsApp is the only provider whose sends
    // need the same connection that receives, so outbound checks this map and
    // fails retryably when this instance does not hold the lease.
    private readonly sockets = new Map<string, WASocket>()
    private readonly sendQueues = new Map<string, Promise<unknown>>()
    private readonly typingStops = new Map<string, Set<() => void>>()
    private readonly messageKeys = new Map<string, Map<string, WAMessageKey>>()

    constructor(
        private readonly repo: ChannelsRepository,
        private readonly crypto: CryptoService
    ) {}

    validateConfig(config: unknown): WhatsappChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botJid: optionalString(c.botJid),
            botName: optionalString(c.botName),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            allowedChatIds: stringList(c.allowedChatIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            // Linked devices cannot reliably edit a delivered message, so a
            // streaming preview would post edits nobody sees.
            progressMode:
                parseProgressMode(c.progressMode) === 'activity'
                    ? 'activity'
                    : 'final',
            outboundFiles: c.outboundFiles !== false,
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(credentials: unknown): null {
        // Pairing produces a Signal session, not a token: it rotates on nearly
        // every message and lives in channel_provider_states so the manager's
        // credential fingerprint does not restart the socket on every write.
        if (credentials !== null && credentials !== undefined)
            throw new BadRequestException(
                'whatsapp channels carry no credentials; pair by scanning the QR code'
            )
        return null
    }

    managesConnection(): boolean {
        return true
    }

    async start(
        ctx: ChannelContext,
        onInbound: InboundHandler,
        onStatus?: StatusHandler
    ): Promise<ChannelHandle> {
        const channelId = ctx.channel.id
        const stored = await this.loadState(channelId)
        if (!stored)
            throw new Error(
                'whatsapp channel has no paired session — scan the QR code again'
            )
        if (stored.loggedOut) throw new Error(WHATSAPP_LOGGED_OUT_MESSAGE)

        const snapshot = await deserializeWhatsappAuth(
            this.crypto.decrypt({
                ciphertext: stored.authCiphertext,
                keyVersion: stored.keyVersion
            })
        )
        let stopped = false
        const store = await createWhatsappAuthStore({
            load: async () => snapshot,
            save: async (next) =>
                this.saveAuth(channelId, next, {
                    botJid: stored.botJid ?? null
                }),
            onError: (err) =>
                this.logger.warn(
                    `whatsapp auth persist failed channel=${channelId}: ${err.message}`
                )
        })
        const sock = await createWaSocket({ state: store.state })
        this.sockets.set(channelId, sock)

        // Debounced, not flushed: creds rotate on nearly every message, and a
        // write per rotation would hammer the row for no durability gain.
        sock.ev.on('creds.update', () => {
            store.touch()
        })

        sock.ev.on('connection.update', (update) => {
            if (stopped) return
            if (update.connection === 'open') {
                onStatus?.('connected')
                return
            }
            if (update.connection !== 'close') return
            const code = waCloseCode(update.lastDisconnect?.error)
            if (code === WA_LOGGED_OUT) {
                // Terminal: the user removed the linked device. Recorded so a
                // reconnect does not spin against dead credentials.
                void this.markLoggedOut(channelId).catch((err) =>
                    this.logger.warn(
                        `whatsapp logout persist failed channel=${channelId}: ${(err as Error).message}`
                    )
                )
                onStatus?.('error', { message: WHATSAPP_LOGGED_OUT_MESSAGE })
                return
            }
            // Everything else (including 515 right after pairing and 440 when
            // another linked device takes over) is recoverable by a fresh
            // socket, which the manager's persisted backoff arranges.
            onStatus?.('error', {
                message: `whatsapp connection closed${code ? ` (code ${code})` : ''}`
            })
        })

        sock.ev.on('messages.upsert', (batch) => {
            if (stopped || batch.type !== 'notify') return
            void (async () => {
                for (const message of batch.messages) {
                    const event = this.normalizeInbound(message, stored.botJid)
                    if (!event) continue
                    this.rememberKey(channelId, message.key)
                    try {
                        await onInbound(event)
                    } catch (err) {
                        this.logger.error(
                            `whatsapp inbound dispatch failed channel=${channelId}: ${(err as Error).message}`
                        )
                    }
                }
            })()
        })

        return {
            status: 'connecting',
            stop: async () => {
                stopped = true
                this.sockets.delete(channelId)
                for (const stop of this.typingStops.get(channelId) ?? [])
                    stop()
                this.typingStops.delete(channelId)
                this.messageKeys.delete(channelId)
                try {
                    sock.end(undefined)
                } catch {
                    // The socket may already be torn down; nothing to do.
                }
                // Auth rotated during this session must outlive the socket, or
                // the next start() replays stale Signal state.
                await store.flush().catch(() => undefined)
                store.stop()
            }
        }
    }

    parseInbound(): NormalizedInboundEvent {
        throw new UnsupportedEventError('whatsapp_uses_socket_only')
    }

    verifySignature(): SignatureCheck {
        return { ok: false, reason: 'whatsapp_uses_socket_only' }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: WhatsappChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        if (event.chatType === 'private')
            return {
                scopeKey: `whatsapp:dm:${enc(event.chatId)}`,
                scopeName: event.senderName ?? event.chatId
            }
        const base = `whatsapp:group:${enc(event.chatId)}`
        return {
            scopeKey: config.shareSessionInChannel
                ? base
                : `${base}:${enc(event.senderId)}`,
            scopeName: event.senderName ?? event.chatId
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: WhatsappChannelConfig
    ): InboundActorPolicy {
        const operatorIds = config.operatorUserIds ?? []
        const senderJids = [event.senderId]
        const operator = matchesAny(operatorIds, senderJids)
        const allowedChatIds = config.allowedChatIds ?? []
        if (
            event.chatType === 'group' &&
            allowedChatIds.length > 0 &&
            !matchesAny(allowedChatIds, [event.chatId])
        )
            return { allowed: false, reason: 'chat_not_allowed', operator }
        const allowedIds = config.allowedUserIds ?? []
        const allowed =
            allowedIds.length === 0 ||
            operator ||
            matchesAny(allowedIds, senderJids)
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const jid = jidFromScopeKey(scopeKey)
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendJidText(ctx.channel.id, jid, text)
        )
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        if (target.kind === 'reply')
            throw new BadRequestException(
                'whatsapp channel cannot address a reply target'
            )
        const jid = toWhatsappJid(
            target.kind === 'chat' ? target.chatId : target.userId
        )
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendJidText(ctx.channel.id, jid, text)
        )
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const jid = jidFromScopeKey(scopeKey)
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendJidAttachments(ctx.channel.id, jid, files)
        )
    }

    async sendDirectAttachments(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        if (target.kind === 'reply')
            throw new BadRequestException(
                'whatsapp channel cannot address a reply target'
            )
        const jid = toWhatsappJid(
            target.kind === 'chat' ? target.chatId : target.userId
        )
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendJidAttachments(ctx.channel.id, jid, files)
        )
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<() => void> {
        const channelId = ctx.channel.id
        const sock = this.sockets.get(channelId)
        if (!sock) return () => undefined
        const jid = jidFromScopeKey(scopeKey)
        let warned = false
        const presence = (state: 'composing' | 'paused'): void => {
            void sock.sendPresenceUpdate(state, jid).catch((err: Error) => {
                if (warned) return
                warned = true
                this.logger.warn(
                    `whatsapp presence failed channel=${channelId}: ${err.message}`
                )
            })
        }
        presence('composing')
        // WhatsApp drops the typing indicator after ~10s, so it is re-sent
        // until the turn ends or the cap fires.
        const interval = setInterval(
            () => presence('composing'),
            WHATSAPP_TYPING_REFRESH_MS
        )
        interval.unref?.()
        let stopped = false
        const stop = (): void => {
            if (stopped) return
            stopped = true
            clearInterval(interval)
            clearTimeout(cap)
            this.typingStops.get(channelId)?.delete(stop)
            presence('paused')
        }
        const cap = setTimeout(stop, WHATSAPP_TYPING_MAX_MS)
        cap.unref?.()
        let stops = this.typingStops.get(channelId)
        if (!stops) {
            stops = new Set()
            this.typingStops.set(channelId, stops)
        }
        stops.add(stop)
        return stop
    }

    async setInboundReaction(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void> {
        const channelId = ctx.channel.id
        const sock = this.sockets.get(channelId)
        if (!sock) return
        const key = this.messageKeys.get(channelId)?.get(providerMessageId)
        // Reacting needs the original key; without it the platform call is
        // meaningless, and a missing reaction is never worth failing a turn.
        if (!key) return
        const jid = jidFromScopeKey(scopeKey)
        await sock
            .sendMessage(jid, {
                react: { text: REACTION_EMOJI[state], key }
            })
            .catch((err: Error) =>
                this.logger.warn(
                    `whatsapp reaction failed channel=${channelId}: ${err.message}`
                )
            )
    }

    async downloadAttachment(
        _ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const descriptor = decodeMediaDescriptor(attachment.url)
        if (!descriptor)
            throw new BadRequestException(
                'invalid whatsapp attachment descriptor'
            )
        return downloadWhatsappMedia(descriptor, opts.maxBytes)
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const stored = await this.loadState(ctx.channel.id)
        if (!stored)
            return { ok: false, message: 'no paired WhatsApp session stored' }
        if (stored.loggedOut)
            return { ok: false, message: WHATSAPP_LOGGED_OUT_MESSAGE }
        const lines = [`linked number: ${stored.botJid ?? 'unknown'}`]
        const connected = this.sockets.has(ctx.channel.id)
        if (ctx.channel.status !== 'active')
            return {
                ok: false,
                message: [
                    ...lines,
                    `connection: channel is ${ctx.channel.status}`
                ].join('\n')
            }
        lines.push(
            connected
                ? 'connection: live on this instance'
                : 'connection: held by another instance'
        )
        return { ok: true, message: lines.join('\n') }
    }

    normalizeInbound(
        message: WAMessage,
        botJid: string | null | undefined
    ): NormalizedInboundEvent | null {
        const remoteJid = message.key?.remoteJid
        // fromMe echoes the agent's own replies back; broadcast and newsletter
        // jids are not conversations the agent can answer.
        if (!remoteJid || message.key?.fromMe) return null
        if (
            remoteJid === 'status@broadcast' ||
            remoteJid.endsWith('@broadcast') ||
            remoteJid.endsWith('@newsletter')
        )
            return null
        const content = unwrapContent(
            message.message as Record<string, unknown> | null
        )
        // Protocol messages (receipts, revokes, key distribution) have no
        // content node worth surfacing.
        if (!content || content.protocolMessage || content.reactionMessage)
            return null

        const group = isGroupJid(remoteJid)
        const senderId = group
            ? (message.key?.participantAlt ??
              message.key?.participant ??
              remoteJid)
            : remoteJid
        const text = extractText(content).trim()
        const attachments = this.buildAttachments(content)
        if (!text && attachments.length === 0) return null

        const contextInfo = contextInfoOf(content)
        const mentioned = Array.isArray(contextInfo?.mentionedJid)
            ? (contextInfo.mentionedJid as string[])
            : []
        const quotedParticipant =
            typeof contextInfo?.participant === 'string'
                ? contextInfo.participant
                : null
        const selfMentioned = botJid
            ? mentioned.some((jid) => whatsappIdentityMatches(botJid, jid)) ||
              (quotedParticipant
                  ? whatsappIdentityMatches(botJid, quotedParticipant)
                  : false)
            : false

        return {
            providerEventId: `${remoteJid}|${message.key?.id ?? ''}`,
            chatId: remoteJid,
            chatType: group ? 'group' : 'private',
            senderId,
            senderName: message.pushName ?? null,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            // DMs always reach the agent; only group traffic is mention-gated,
            // and the bridge applies that gate for group events only.
            isMention: group ? selfMentioned : true,
            messageId: message.key?.id ?? null,
            replyToMessageId:
                typeof contextInfo?.stanzaId === 'string'
                    ? contextInfo.stanzaId
                    : null,
            replyTargetId: null,
            raw: message
        }
    }

    private buildAttachments(
        content: Record<string, unknown>
    ): NormalizedInboundAttachment[] {
        const media = extractMedia(content)
        // Audio and video are left to the text placeholder: the bridge's
        // attachment policy would drop them after paying for the download.
        if (!media || media.kind === 'audio' || media.kind === 'video')
            return []
        const contentType =
            typeof media.node.mimetype === 'string'
                ? media.node.mimetype
                : 'application/octet-stream'
        const name = whatsappMediaName(
            media.kind,
            contentType,
            typeof media.node.fileName === 'string'
                ? media.node.fileName
                : null
        )
        return [
            {
                url: encodeMediaDescriptor({
                    kind: media.kind,
                    message: media.node,
                    name,
                    contentType
                }),
                name,
                contentType,
                size:
                    typeof media.node.fileLength === 'number'
                        ? media.node.fileLength
                        : null
            }
        ]
    }

    private async sendJidText(
        channelId: string,
        jid: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const sock = this.requireSocket(channelId)
        const chunks = chunkText(text, WHATSAPP_MAX_TEXT_LEN)
        let providerMessageId: string | undefined
        for (let i = 0; i < chunks.length; i += 1) {
            if (i > 0) await sleep(WHATSAPP_CHUNK_DELAY_MS)
            try {
                const sent = await sock.sendMessage(jid, { text: chunks[i] })
                providerMessageId = sent?.key?.id ?? providerMessageId
            } catch (err) {
                // Nothing was delivered yet, so the outbound sweep can safely
                // retry the whole message. A later chunk must not rethrow: the
                // retry would repeat the prefix the user already read.
                if (i === 0) throw err
                this.logger.warn(
                    `whatsapp chunk ${i + 1}/${chunks.length} failed channel=${channelId}: ${(err as Error).message}`
                )
                await sock
                    .sendMessage(jid, { text: WHATSAPP_INCOMPLETE_NOTICE })
                    .catch(() => undefined)
                break
            }
        }
        return { providerMessageId }
    }

    private async sendJidAttachments(
        channelId: string,
        jid: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const sock = this.requireSocket(channelId)
        let providerMessageId: string | undefined
        for (const file of files) {
            const isImage = file.contentType.startsWith('image/')
            const sent = await sock.sendMessage(
                jid,
                isImage
                    ? { image: file.bytes, mimetype: file.contentType }
                    : {
                          document: file.bytes,
                          mimetype: file.contentType,
                          fileName: file.name
                      }
            )
            providerMessageId = sent?.key?.id ?? providerMessageId
        }
        return { providerMessageId }
    }

    private requireSocket(channelId: string): WASocket {
        const sock = this.sockets.get(channelId)
        // Sending needs the same connection that receives. When another
        // instance holds the channel lease this throws, the delivery stays
        // queued, and the sweep retries where the socket lives.
        if (!sock) throw new Error(WHATSAPP_NO_SOCKET_MESSAGE)
        return sock
    }

    private enqueueSend<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.sendQueues.get(channelId) ?? Promise.resolve()
        const next = prev.then(fn, fn)
        this.sendQueues.set(
            channelId,
            next.catch(() => undefined)
        )
        return next
    }

    private rememberKey(channelId: string, key: WAMessageKey): void {
        if (!key?.id) return
        let cache = this.messageKeys.get(channelId)
        if (!cache) {
            cache = new Map()
            this.messageKeys.set(channelId, cache)
        }
        cache.delete(key.id)
        cache.set(key.id, key)
        while (cache.size > WHATSAPP_KEY_CACHE_MAX) {
            const oldest = cache.keys().next().value
            if (oldest === undefined) break
            cache.delete(oldest)
        }
    }

    private async loadState(
        channelId: string
    ): Promise<WhatsappProviderState | null> {
        const row = await this.repo.getProviderState(channelId)
        const state = row?.stateJson as WhatsappProviderState | undefined
        return state?.authCiphertext ? state : null
    }

    private async saveAuth(
        channelId: string,
        snapshot: WhatsappAuthSnapshot,
        opts: { botJid: string | null }
    ): Promise<void> {
        const serialized = await serializeWhatsappAuth(snapshot)
        const encrypted = this.crypto.encrypt(serialized)
        const now = new Date()
        await this.repo.upsertProviderState({
            channelId,
            stateJson: {
                v: 1,
                authCiphertext: encrypted.ciphertext,
                keyVersion: encrypted.keyVersion,
                botJid: snapshot.creds?.me?.id ?? opts.botJid
            } satisfies WhatsappProviderState,
            createdAt: now,
            updatedAt: now
        })
    }

    private async markLoggedOut(channelId: string): Promise<void> {
        const current = await this.loadState(channelId)
        if (!current) return
        const now = new Date()
        await this.repo.upsertProviderState({
            channelId,
            stateJson: {
                ...current,
                loggedOut: true
            } satisfies WhatsappProviderState,
            createdAt: now,
            updatedAt: now
        })
    }
}
