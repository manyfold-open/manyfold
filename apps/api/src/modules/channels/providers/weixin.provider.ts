import type {
    ChannelTestResult,
    WeixinChannelConfig,
    WeixinChannelCredentials
} from '@manyfold/shared'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHandle,
    type ChannelSendTarget,
    type ChannelProvider,
    type InboundActorPolicy,
    type InboundHandler,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type OutboundAttachment,
    type RegistrationResult,
    type SignatureCheck,
    type StatusHandler
} from '../channel-provider'
import { ChannelsRepository } from '../channels.repository'
import { parseProgressMode, parseResetOnIdleMins } from '../config-helpers'
import { chunkText } from '../text-chunk'
import { filterWeixinMarkdown } from './weixin-format'
import {
    decodeCdnDescriptor,
    downloadWeixinCdnMedia,
    encodeCdnDescriptor,
    prepareWeixinUpload,
    uploadWeixinCdnCiphertext,
    weixinMediaAesKeyForWire,
    type WeixinCdnDescriptor
} from './weixin-cdn'
import {
    WEIXIN_DEFAULT_BASE_URL,
    WEIXIN_LONG_POLL_TIMEOUT_MS,
    weixinApiError,
    weixinGetConfig,
    weixinGetUpdates,
    weixinGetUploadUrl,
    weixinNotifyStart,
    weixinNotifyStop,
    weixinRateLimited,
    weixinSendMediaItem,
    weixinSendMessage,
    weixinSendTyping,
    weixinStaleSession,
    WeixinMessageType,
    WeixinItemType,
    WeixinUploadMediaType,
    type WeixinCdnMedia,
    type WeixinMessage,
    type WeixinMessageItem,
    type WeixinRequestOptions
} from './weixin-ilink'
// C2C CDN is national and must bypass any outbound proxy; the default gateway
// base is also the media base.
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

const envInt = (name: string, fallback: number): number => {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

// Read at call time so operators can tune per deploy without depending on
// module load order (and so tests can exercise chunking deterministically).
const weixinMaxTextLen = (): number => envInt('MF_WEIXIN_CHUNK_SIZE', 2000)
const weixinChunkDelayMs = (): number => envInt('MF_WEIXIN_CHUNK_DELAY_MS', 1500)
const WEIXIN_RATE_CIRCUIT_OPEN_MS = envInt(
    'MF_WEIXIN_RATE_CIRCUIT_OPEN_MS',
    30_000
)
// iLink -14 means the QR-issued session is gone; retrying faster only burns
// requests against a dead token, so probe at most hourly (matches Tencent's
// own plugin). The pause lives in provider memory: manager reconnect bounces
// land back in start(), see the pause and idle without touching the gateway.
const WEIXIN_SESSION_PAUSE_MS = envInt(
    'MF_WEIXIN_SESSION_PAUSE_MS',
    60 * 60_000
)
const WEIXIN_SEND_RETRIES = 3
const WEIXIN_SEND_RETRY_DELAY_MS = 500
const WEIXIN_TYPING_REFRESH_MS = 5_000
const WEIXIN_TYPING_MAX_MS = 10 * 60_000
const WEIXIN_TYPING_TICKET_TTL_MS = 10 * 60_000
const WEIXIN_CONTEXT_TOKENS_MAX = 500
const WEIXIN_SESSION_EXPIRED_MESSAGE =
    'weixin session expired (errcode -14) — re-scan the QR code and update the bot token'
const WEIXIN_INCOMPLETE_NOTICE = '⚠️ 消息发送不完整，剩余内容已丢弃'

interface WeixinProviderState {
    syncBuf?: string | null
    contextTokens?: Record<string, string>
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal?.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })

const enc = (value: string): string => encodeURIComponent(value)

const peerFromScopeKey = (scopeKey: string): string => {
    const parts = scopeKey.split(':')
    if (parts[0] !== 'weixin' || parts[1] !== 'dm' || !parts[2])
        throw new BadRequestException(`invalid weixin scope key: ${scopeKey}`)
    return decodeURIComponent(parts[2])
}

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

const normalizeBaseUrl = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim().replace(/\/+$/, '')
    if (!trimmed) return null
    try {
        const url = new URL(trimmed)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
        return url.toString().replace(/\/+$/, '')
    } catch {
        return null
    }
}

const itemText = (items: WeixinMessageItem[] | undefined): string => {
    const parts: string[] = []
    for (const item of items ?? []) {
        switch (item.type) {
            case WeixinItemType.TEXT: {
                const text = item.text_item?.text?.trim()
                if (text) parts.push(text)
                break
            }
            case WeixinItemType.IMAGE:
                parts.push('[图片]')
                break
            case WeixinItemType.VOICE: {
                const transcript = item.voice_item?.text?.trim()
                parts.push(transcript ? `[语音转写] ${transcript}` : '[语音]')
                break
            }
            case WeixinItemType.FILE: {
                const name = item.file_item?.file_name?.trim()
                parts.push(name ? `[文件 ${name}]` : '[文件]')
                break
            }
            case WeixinItemType.VIDEO:
                parts.push('[视频]')
                break
            default:
                break
        }
    }
    return parts.join('\n').trim()
}

const refMessageId = (items: WeixinMessageItem[] | undefined): string | null => {
    for (const item of items ?? []) {
        if (item.ref_msg)
            return item.ref_msg.message_item?.msg_id ?? 'ref'
    }
    return null
}

const cdnDescriptorFromMedia = (
    media: WeixinCdnMedia | undefined,
    name: string,
    contentType: string,
    aesKeyHex?: string
): WeixinCdnDescriptor | null => {
    if (!media) return null
    if (!media.encrypt_query_param && !media.full_url) return null
    if (!media.aes_key && !aesKeyHex) return null
    return {
        q: media.encrypt_query_param,
        u: media.full_url,
        k: media.aes_key,
        ak: aesKeyHex,
        name,
        contentType
    }
}

// Best-effort content type from a filename, used only for the bridge's
// pre-download allowlist check; the real type is sniffed after decryption for
// images. Non-whitelisted files are dropped by the bridge, which is intended.
const contentTypeFromName = (name: string): string => {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const map: Record<string, string> = {
        pdf: 'application/pdf',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        json: 'application/json',
        xml: 'application/xml',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ppt: 'application/vnd.ms-powerpoint',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    return map[ext] ?? 'application/octet-stream'
}

// Build inbound attachments for image/file items. Audio and video are left as
// text placeholders: the global attachment policy allows neither, so the
// bridge would drop them before download anyway.
const itemAttachments = (
    items: WeixinMessageItem[] | undefined
): NormalizedInboundAttachment[] => {
    const out: NormalizedInboundAttachment[] = []
    for (const item of items ?? []) {
        if (item.type === WeixinItemType.IMAGE) {
            const descriptor = cdnDescriptorFromMedia(
                item.image_item?.media,
                'image.jpg',
                'image/jpeg',
                item.image_item?.aeskey
            )
            if (descriptor)
                out.push({
                    url: encodeCdnDescriptor(descriptor),
                    name: descriptor.name,
                    contentType: descriptor.contentType
                })
        } else if (item.type === WeixinItemType.FILE) {
            const name = item.file_item?.file_name?.trim() || 'file'
            const descriptor = cdnDescriptorFromMedia(
                item.file_item?.media,
                name,
                contentTypeFromName(name)
            )
            if (descriptor)
                out.push({
                    url: encodeCdnDescriptor(descriptor),
                    name: descriptor.name,
                    contentType: descriptor.contentType
                })
        }
    }
    return out
}

@Injectable()
export class WeixinChannelProvider implements ChannelProvider {
    readonly name = 'weixin' as const
    private readonly logger = new Logger(WeixinChannelProvider.name)
    // -14 cooldown per channel; provider is a singleton so this survives the
    // manager's stop/start reconnect bounces (the DB backoff caps at 600s,
    // far below the hourly probe cadence this enforces).
    private readonly pausedUntil = new Map<string, number>()
    private readonly sendQueues = new Map<string, Promise<unknown>>()
    private readonly circuitUntil = new Map<string, number>()
    private readonly typingTickets = new Map<
        string,
        { ticket: string; expiresAt: number }
    >()
    private readonly typingStops = new Map<string, Set<() => void>>()

    constructor(private readonly repo: ChannelsRepository) {}

    validateConfig(config: unknown): WeixinChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botId: optionalString(c.botId),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            progressMode: parseProgressMode(c.progressMode),
            outboundFiles: c.outboundFiles !== false,
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(
        credentials: unknown
    ): WeixinChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const botToken = typeof c.botToken === 'string' ? c.botToken.trim() : ''
        if (botToken.length < 8 || /\s/.test(botToken))
            throw new BadRequestException('credentials.botToken is required')
        return {
            botToken,
            baseUrl: normalizeBaseUrl(c.baseUrl)
        }
    }

    managesConnection(): boolean {
        return true
    }

    async start(
        ctx: ChannelContext,
        onInbound: InboundHandler,
        onStatus?: StatusHandler
    ): Promise<ChannelHandle> {
        const apiOpts = this.apiOptions(ctx)
        const channelId = ctx.channel.id

        let stopped = false
        let announcedConnected = false
        const abort = new AbortController()
        const state = await this.loadState(channelId)
        let syncBuf = state.syncBuf ?? ''
        let hasCursor = syncBuf.length > 0
        const contextTokens = new Map(Object.entries(state.contextTokens ?? {}))
        let pollTimeoutMs = WEIXIN_LONG_POLL_TIMEOUT_MS + 5_000

        const loop = async (): Promise<void> => {
            const pauseLeft = (this.pausedUntil.get(channelId) ?? 0) - Date.now()
            if (pauseLeft > 0) {
                onStatus?.('error', { message: WEIXIN_SESSION_EXPIRED_MESSAGE })
                await sleep(pauseLeft, abort.signal)
                if (stopped) return
            }
            this.pausedUntil.delete(channelId)

            while (!stopped) {
                let resp
                try {
                    resp = await weixinGetUpdates(
                        { ...apiOpts, signal: abort.signal, timeoutMs: pollTimeoutMs },
                        syncBuf
                    )
                } catch (err) {
                    if (stopped) return
                    const message = (err as Error).message
                    this.logger.warn(
                        `weixin getupdates failed channel=${channelId}: ${message}`
                    )
                    onStatus?.('error', { message })
                    return
                }
                if (stopped) return
                if (
                    typeof resp.longpolling_timeout_ms === 'number' &&
                    resp.longpolling_timeout_ms > 0
                )
                    pollTimeoutMs = resp.longpolling_timeout_ms + 5_000
                if (weixinStaleSession(resp)) {
                    this.pausedUntil.set(
                        channelId,
                        Date.now() + WEIXIN_SESSION_PAUSE_MS
                    )
                    this.logger.warn(
                        `weixin session expired channel=${channelId}, pausing probes for ${Math.round(WEIXIN_SESSION_PAUSE_MS / 60_000)}min`
                    )
                    onStatus?.('error', {
                        message: WEIXIN_SESSION_EXPIRED_MESSAGE
                    })
                    return
                }
                if (weixinApiError(resp)) {
                    const message = `weixin getupdates ret=${resp.ret ?? ''} errcode=${resp.errcode ?? ''} ${resp.errmsg ?? ''}`.trim()
                    this.logger.warn(`${message} channel=${channelId}`)
                    onStatus?.('error', { message })
                    return
                }

                const msgs = resp.msgs ?? []
                if (resp.get_updates_buf) syncBuf = resp.get_updates_buf

                if (!hasCursor) {
                    // Baseline sync: an empty cursor makes iLink replay the
                    // recent backlog; persist the cursor and drop those
                    // messages so channel creation never floods the agent.
                    if (syncBuf.length > 0) {
                        hasCursor = true
                        await this.saveState(channelId, syncBuf, contextTokens)
                        if (msgs.length > 0)
                            this.logger.log(
                                `weixin baseline sync dropped ${msgs.length} backlog message(s) channel=${channelId}`
                            )
                    }
                    if (!announcedConnected) {
                        announcedConnected = true
                        onStatus?.('connected')
                    }
                    continue
                }

                for (const msg of msgs) {
                    const from = msg.from_user_id?.trim()
                    if (from && msg.context_token)
                        this.rememberContextToken(
                            contextTokens,
                            from,
                            msg.context_token
                        )
                }
                // Reply credentials and the cursor must be durable before the
                // bridge sees the events: a crash after dispatch would replay
                // events whose context tokens were never persisted.
                await this.saveState(channelId, syncBuf, contextTokens)

                for (const msg of msgs) {
                    if (stopped) return
                    if (msg.message_type === WeixinMessageType.BOT) continue
                    const event = normalizeInbound(msg)
                    if (!event) continue
                    try {
                        await onInbound(event)
                    } catch (err) {
                        this.logger.error(
                            `weixin inbound dispatch failed channel=${channelId}: ${(err as Error).message}`
                        )
                    }
                }

                if (!announcedConnected) {
                    announcedConnected = true
                    onStatus?.('connected')
                }
            }
        }

        void loop().catch((err) => {
            if (!stopped)
                this.logger.error(
                    `weixin poll loop crashed channel=${channelId}: ${(err as Error).message}`
                )
        })

        return {
            status: 'connecting',
            stop: async () => {
                stopped = true
                abort.abort()
                for (const stop of this.typingStops.get(channelId) ?? [])
                    stop()
                this.typingStops.delete(channelId)
                await weixinNotifyStop({ ...apiOpts, timeoutMs: 5_000 }).catch(
                    () => undefined
                )
            }
        }
    }

    parseInbound(): NormalizedInboundEvent {
        throw new UnsupportedEventError('weixin_uses_long_poll_only')
    }

    verifySignature(): SignatureCheck {
        return { ok: false, reason: 'weixin_uses_long_poll_only' }
    }

    computeScopeKey(event: NormalizedInboundEvent): {
        scopeKey: string
        scopeName: string | null
    } {
        return {
            scopeKey: `weixin:dm:${enc(event.senderId)}`,
            scopeName: event.senderName ?? event.senderId
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: WeixinChannelConfig
    ): InboundActorPolicy {
        const operatorIds = config.operatorUserIds ?? []
        const operator = operatorIds.includes(event.senderId)
        const allowedIds = config.allowedUserIds ?? []
        const allowed =
            allowedIds.length === 0 ||
            allowedIds.includes(event.senderId) ||
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
        const peer = peerFromScopeKey(scopeKey)
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendPeerText(ctx, peer, text)
        )
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        // WeChat is DM-only and cannot address arbitrary chats or reply to
        // provider message ids, so only a user target is meaningful.
        if (target.kind !== 'user')
            throw new BadRequestException(
                'weixin channel can only send to a user (DM)'
            )
        const peer = target.userId
        const contextToken = await this.contextTokenFor(ctx.channel.id, peer)
        if (!contextToken)
            throw new BadRequestException(
                'no reply credential for this user yet — they must message the bot first'
            )
        return this.enqueueSend(ctx.channel.id, () =>
            this.sendPeerText(ctx, peer, text)
        )
    }

    // iLink has no standalone message id and no addressable user handle: every
    // outbound call needs the context_token that arrived with the peer's own
    // message. sendText resolves it from provider state; an agent that replies
    // for us has to be handed the one on this event.
    replyCredential(event: NormalizedInboundEvent): string | null {
        const raw = event.raw as WeixinMessage | undefined
        return raw?.context_token?.trim() || null
    }

    async fetchReplyContext(
        _ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<string | null> {
        const raw = event.raw as WeixinMessage | undefined
        for (const item of raw?.item_list ?? []) {
            const ref = item.ref_msg
            if (!ref) continue
            const snippet = (
                ref.title ??
                itemText(ref.message_item ? [ref.message_item] : [])
            )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 200)
            return snippet ? `[Replying to: ${snippet}]` : null
        }
        return null
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const peer = peerFromScopeKey(scopeKey)
        return this.enqueueSend(ctx.channel.id, async () => {
            let providerMessageId: string | undefined
            for (const file of files) {
                providerMessageId = await this.sendOneAttachment(
                    ctx,
                    peer,
                    file
                )
            }
            return { providerMessageId }
        })
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<() => void> {
        const peer = peerFromScopeKey(scopeKey)
        const channelId = ctx.channel.id
        const ticket = await this.typingTicket(ctx, peer).catch((err) => {
            this.logger.warn(
                `weixin typing ticket failed channel=${channelId}: ${(err as Error).message}`
            )
            return null
        })
        if (!ticket) return () => undefined

        const apiOpts = this.apiOptions(ctx)
        let warned = false
        const setTyping = (status: 1 | 2): void => {
            void weixinSendTyping(apiOpts, {
                userId: peer,
                typingTicket: ticket,
                status
            }).catch((err) => {
                if (warned) return
                warned = true
                this.logger.warn(
                    `weixin typing failed channel=${channelId}: ${(err as Error).message}`
                )
            })
        }
        setTyping(1)
        const interval = setInterval(
            () => setTyping(1),
            WEIXIN_TYPING_REFRESH_MS
        )
        interval.unref?.()
        let stopped = false
        const stop = (): void => {
            if (stopped) return
            stopped = true
            clearInterval(interval)
            clearTimeout(cap)
            this.typingStops.get(channelId)?.delete(stop)
            setTyping(2)
        }
        const cap = setTimeout(stop, WEIXIN_TYPING_MAX_MS)
        cap.unref?.()
        let stops = this.typingStops.get(channelId)
        if (!stops) {
            stops = new Set()
            this.typingStops.set(channelId, stops)
        }
        stops.add(stop)
        return stop
    }

    async register(ctx: ChannelContext): Promise<RegistrationResult> {
        const probe = await this.probe(ctx)
        if (!probe.ok) return probe
        return {
            ok: true,
            activate: true,
            message: 'weixin ilink token verified'
        }
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const descriptor = decodeCdnDescriptor(attachment.url)
        if (!descriptor)
            throw new BadRequestException('invalid weixin attachment descriptor')
        const cdnBaseUrl = this.cdnBaseUrl(ctx)
        return downloadWeixinCdnMedia(descriptor, cdnBaseUrl, opts.maxBytes)
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const probe = await this.probe(ctx)
        if (!probe.ok) return { ok: false, message: probe.message ?? 'failed' }
        const lines = ['ilink gateway: reachable, token accepted']
        let ok = true
        if (ctx.channel.status === 'active') lines.push('poll loop: active')
        else {
            ok = false
            lines.push(`poll loop: channel is ${ctx.channel.status}`)
        }
        const state = await this.repo.getProviderState(ctx.channel.id)
        const stateJson = (state?.stateJson ?? {}) as WeixinProviderState
        lines.push(
            `sync cursor: ${stateJson.syncBuf ? 'stored' : 'not stored yet'}`
        )
        return { ok, message: lines.join('\n') }
    }

    private async probe(
        ctx: ChannelContext
    ): Promise<{ ok: boolean; message?: string }> {
        let apiOpts: WeixinRequestOptions
        try {
            apiOpts = this.apiOptions(ctx)
        } catch (err) {
            return { ok: false, message: (err as Error).message }
        }
        try {
            const resp = await weixinNotifyStart(apiOpts)
            if (weixinStaleSession(resp))
                return { ok: false, message: WEIXIN_SESSION_EXPIRED_MESSAGE }
            if (weixinApiError(resp))
                return {
                    ok: false,
                    message: `weixin notifystart ret=${resp.ret ?? ''} errcode=${resp.errcode ?? ''} ${resp.errmsg ?? ''}`.trim()
                }
            return { ok: true }
        } catch (err) {
            return {
                ok: false,
                message: `weixin gateway unreachable: ${(err as Error).message}`
            }
        }
    }

    private apiOptions(ctx: ChannelContext): WeixinRequestOptions {
        const credentials = ctx.credentials as WeixinChannelCredentials | null
        if (!credentials?.botToken)
            throw new BadRequestException('weixin channel requires botToken')
        return {
            baseUrl: credentials.baseUrl ?? WEIXIN_DEFAULT_BASE_URL,
            token: credentials.botToken
        }
    }

    // Upload one file to the CDN and send it as an image or file item. Images
    // go as an IMAGE item; everything else as a FILE item.
    private async sendOneAttachment(
        ctx: ChannelContext,
        peer: string,
        file: OutboundAttachment
    ): Promise<string | undefined> {
        const channelId = ctx.channel.id
        this.assertCircuitClosed(channelId)
        const apiOpts = this.apiOptions(ctx)
        const contextToken = await this.contextTokenFor(channelId, peer)
        const isImage = file.contentType.startsWith('image/')
        const plan = prepareWeixinUpload(file.bytes)
        const uploadResp = await weixinGetUploadUrl(apiOpts, {
            filekey: plan.filekey,
            mediaType: isImage
                ? WeixinUploadMediaType.IMAGE
                : WeixinUploadMediaType.FILE,
            toUserId: peer,
            rawSize: plan.rawSize,
            rawMd5: plan.rawMd5,
            cipherSize: plan.cipherSize,
            aesKeyHex: plan.aesKeyHex
        })
        if (weixinRateLimited(uploadResp)) {
            this.circuitUntil.set(
                channelId,
                Date.now() + WEIXIN_RATE_CIRCUIT_OPEN_MS
            )
            throw new Error('weixin getuploadurl rate limited')
        }
        if (weixinApiError(uploadResp))
            throw new Error(
                `weixin getuploadurl ret=${uploadResp.ret ?? ''} errcode=${uploadResp.errcode ?? ''}`.trim()
            )
        const uploadUrl =
            uploadResp.upload_full_url?.trim() ||
            (uploadResp.upload_param
                ? `${this.cdnBaseUrl(ctx)}/upload?upload_param=${encodeURIComponent(uploadResp.upload_param)}`
                : null)
        if (!uploadUrl) throw new Error('weixin getuploadurl returned no URL')
        const downloadParam = await uploadWeixinCdnCiphertext(
            uploadUrl,
            plan.ciphertext
        )
        const media = {
            encrypt_query_param: downloadParam,
            aes_key: weixinMediaAesKeyForWire(plan.aesKeyHex)
        }
        const item: WeixinMessageItem = isImage
            ? { type: WeixinItemType.IMAGE, image_item: { media } }
            : {
                  type: WeixinItemType.FILE,
                  file_item: { file_name: file.name, media }
              }
        const { resp, clientId } = await weixinSendMediaItem(apiOpts, {
            to: peer,
            item,
            contextToken
        })
        if (weixinApiError(resp))
            throw new Error(
                `weixin send media ret=${resp.ret ?? ''} errcode=${resp.errcode ?? ''}`.trim()
            )
        return clientId
    }

    private cdnBaseUrl(_ctx: ChannelContext): string {
        return WEIXIN_CDN_BASE_URL
    }

    private async sendPeerText(
        ctx: ChannelContext,
        peer: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const channelId = ctx.channel.id
        this.assertCircuitClosed(channelId)
        const apiOpts = this.apiOptions(ctx)
        const contextToken = await this.contextTokenFor(channelId, peer)
        const chunks = chunkText(filterWeixinMarkdown(text), weixinMaxTextLen())
        const chunkDelayMs = weixinChunkDelayMs()
        let providerMessageId: string | undefined
        for (let i = 0; i < chunks.length; i += 1) {
            if (i > 0) await sleep(chunkDelayMs)
            try {
                providerMessageId = await this.sendChunk(
                    apiOpts,
                    channelId,
                    peer,
                    chunks[i],
                    contextToken
                )
            } catch (err) {
                // Chunk 1 failed with nothing delivered: rethrow so the
                // outbound sweep can safely retry the whole delivery. A later
                // chunk failing must NOT rethrow — the sweep would resend the
                // already-delivered prefix — so degrade to a truncation notice.
                if (i === 0) throw err
                this.logger.warn(
                    `weixin chunk ${i + 1}/${chunks.length} failed channel=${channelId}: ${(err as Error).message}`
                )
                await this.sendChunk(
                    apiOpts,
                    channelId,
                    peer,
                    WEIXIN_INCOMPLETE_NOTICE,
                    contextToken
                ).catch(() => undefined)
                break
            }
        }
        return { providerMessageId }
    }

    private async sendChunk(
        apiOpts: WeixinRequestOptions,
        channelId: string,
        peer: string,
        text: string,
        contextToken: string | null
    ): Promise<string> {
        let lastError: Error | null = null
        for (let attempt = 0; attempt < WEIXIN_SEND_RETRIES; attempt += 1) {
            if (attempt > 0) await sleep(WEIXIN_SEND_RETRY_DELAY_MS)
            try {
                const { resp, clientId } = await weixinSendMessage(apiOpts, {
                    to: peer,
                    text,
                    contextToken
                })
                if (weixinRateLimited(resp)) {
                    this.circuitUntil.set(
                        channelId,
                        Date.now() + WEIXIN_RATE_CIRCUIT_OPEN_MS
                    )
                    throw new Error(
                        `weixin sendmessage rate limited (ret=${resp.ret ?? resp.errcode})`
                    )
                }
                if (weixinStaleSession(resp))
                    throw new Error(WEIXIN_SESSION_EXPIRED_MESSAGE)
                if (weixinApiError(resp))
                    throw new Error(
                        `weixin sendmessage ret=${resp.ret ?? ''} errcode=${resp.errcode ?? ''} ${resp.errmsg ?? ''}`.trim()
                    )
                return clientId
            } catch (err) {
                lastError = err as Error
                if (this.circuitOpen(channelId)) break
            }
        }
        throw lastError ?? new Error('weixin sendmessage failed')
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

    private circuitOpen(channelId: string): boolean {
        const until = this.circuitUntil.get(channelId)
        if (until === undefined) return false
        if (Date.now() >= until) {
            this.circuitUntil.delete(channelId)
            return false
        }
        return true
    }

    private assertCircuitClosed(channelId: string): void {
        if (this.circuitOpen(channelId))
            throw new Error(
                'weixin send suppressed: rate-limit circuit open, retry later'
            )
    }

    private async typingTicket(
        ctx: ChannelContext,
        peer: string
    ): Promise<string | null> {
        const cacheKey = `${ctx.channel.id}:${peer}`
        const cached = this.typingTickets.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) return cached.ticket
        const contextToken = await this.contextTokenFor(ctx.channel.id, peer)
        const resp = await weixinGetConfig(this.apiOptions(ctx), {
            userId: peer,
            contextToken
        })
        if (weixinApiError(resp) || !resp.typing_ticket) return null
        this.typingTickets.set(cacheKey, {
            ticket: resp.typing_ticket,
            expiresAt: Date.now() + WEIXIN_TYPING_TICKET_TTL_MS
        })
        return resp.typing_ticket
    }

    private async contextTokenFor(
        channelId: string,
        peer: string
    ): Promise<string | null> {
        const state = await this.repo.getProviderState(channelId)
        const stateJson = (state?.stateJson ?? {}) as WeixinProviderState
        return stateJson.contextTokens?.[peer] ?? null
    }

    private rememberContextToken(
        tokens: Map<string, string>,
        peer: string,
        token: string
    ): void {
        tokens.delete(peer)
        tokens.set(peer, token)
        while (tokens.size > WEIXIN_CONTEXT_TOKENS_MAX) {
            const oldest = tokens.keys().next().value
            if (oldest === undefined) break
            tokens.delete(oldest)
        }
    }

    private async loadState(channelId: string): Promise<WeixinProviderState> {
        const state = await this.repo.getProviderState(channelId)
        const stateJson = (state?.stateJson ?? {}) as WeixinProviderState
        return {
            syncBuf:
                typeof stateJson.syncBuf === 'string' ? stateJson.syncBuf : null,
            contextTokens:
                stateJson.contextTokens &&
                typeof stateJson.contextTokens === 'object'
                    ? stateJson.contextTokens
                    : {}
        }
    }

    private async saveState(
        channelId: string,
        syncBuf: string,
        contextTokens: Map<string, string>
    ): Promise<void> {
        const now = new Date()
        await this.repo.upsertProviderState({
            channelId,
            stateJson: {
                syncBuf,
                contextTokens: Object.fromEntries(contextTokens)
            } satisfies WeixinProviderState,
            createdAt: now,
            updatedAt: now
        })
    }
}

const normalizeInbound = (
    msg: WeixinMessage
): NormalizedInboundEvent | null => {
    const from = msg.from_user_id?.trim()
    if (!from) return null
    const text = itemText(msg.item_list)
    const attachments = itemAttachments(msg.item_list)
    if (!text && attachments.length === 0) return null
    return {
        providerEventId: `${from}|${msg.message_id ?? ''}|${msg.seq ?? ''}|${msg.client_id ?? ''}`,
        chatId: from,
        chatType: 'private',
        senderId: from,
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        isMention: false,
        messageId:
            msg.message_id !== undefined && msg.message_id !== null
                ? String(msg.message_id)
                : (msg.client_id ?? null),
        replyToMessageId: refMessageId(msg.item_list),
        replyTargetId: null,
        raw: msg
    }
}