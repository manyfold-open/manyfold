import type {
    ChannelTestResult,
    TelegramChannelConfig,
    TelegramChannelCredentials
} from '@manyfold/shared'
import { randomBytes } from 'node:crypto'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    UnsupportedEventError,
    type ChannelCommandView,
    type ChannelContext,
    type ChannelHandle,
    type ChannelProvider,
    type ChannelSendTarget,
    type InboundRequest,
    type InboundActorPolicy,
    type NormalizedInboundAction,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type OutboundAttachment,
    type PreviewHandle,
    type RegistrationResult,
    type SendTextOptions,
    type SignatureCheck
} from '../channel-provider'
import {
    channelProviderJsonRequest,
    type ChannelProviderJsonResponse
} from './channel-http'
import {
    parseFinalMessageMode,
    parseProgressMode,
    parseResetOnIdleMins
} from '../config-helpers'
import { SLASH_COMMAND_SPECS } from '../slash/commands'
import {
    ChannelSendError,
    type ChannelSendErrorKind
} from '../channel-send-error'
import { chunkText, wrapMarkdownTables } from '../text-chunk'
import { markdownToTelegramHtml } from './telegram-format'

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const MAX_MESSAGE_LEN = 4000
const TELEGRAM_FILE_PREFIX = 'telegram-file:'
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 15_000
// Telegram's typing status decays after ~5s, so re-fire just inside that.
const TYPING_REFRESH_MS = 5_000
const TYPING_MAX_MS = 10 * 60_000

interface TelegramUpdate {
    update_id?: number
    message?: TelegramMessage
    edited_message?: TelegramMessage
    channel_post?: TelegramMessage
    callback_query?: TelegramCallbackQuery
}

interface TelegramCallbackQuery {
    id: string
    from?: TelegramMessage['from']
    message?: TelegramMessage
    data?: string
}

interface TelegramMessage {
    message_id: number
    message_thread_id?: number
    from?: {
        id: number
        is_bot?: boolean
        username?: string
        first_name?: string
    }
    chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
    text?: string
    caption?: string
    entities?: Array<{
        type: string
        offset: number
        length: number
        user?: { id: number; username?: string }
    }>
    reply_to_message?: TelegramMessage
    quote?: { text?: string }
    photo?: TelegramPhotoSize[]
    document?: TelegramFile
    voice?: TelegramFile
    audio?: TelegramFile
    video?: TelegramFile
}

interface TelegramPhotoSize extends TelegramFile {
    width: number
    height: number
}

interface TelegramFile {
    file_id: string
    file_name?: string
    mime_type?: string
    file_size?: number
}

@Injectable()
export class TelegramChannelProvider implements ChannelProvider {
    readonly name = 'telegram' as const
    // Telegram flood control counts message edits like sends (~1/s per chat).
    readonly previewUpdateMinIntervalMs = 1000
    private readonly logger = new Logger(TelegramChannelProvider.name)

    validateConfig(config: unknown): TelegramChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botUsername:
                typeof c.botUsername === 'string' &&
                c.botUsername.trim().length > 0
                    ? c.botUsername.trim()
                    : null,
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            allowedChatIds: stringList(c.allowedChatIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            threadIsolation: c.threadIsolation !== false,
            progressMode: parseProgressMode(c.progressMode),
            finalMessageMode: parseFinalMessageMode(c.finalMessageMode),
            replyHud: c.replyHud === true,
            outboundFiles: c.outboundFiles !== false,
            ackReaction: c.ackReaction === true,
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(
        credentials: unknown
    ): TelegramChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const botToken = c.botToken
        if (
            typeof botToken !== 'string' ||
            !/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken.trim())
        )
            throw new BadRequestException(
                'credentials.botToken must look like 123456:ABC-DEF...'
            )
        const webhookSecret =
            typeof c.webhookSecret === 'string' &&
            c.webhookSecret.trim().length > 0
                ? c.webhookSecret.trim()
                : null
        return { botToken: botToken.trim(), webhookSecret }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult> {
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        if (!credentials?.botToken)
            return { ok: false, message: 'botToken missing' }
        const config = ctx.config as TelegramChannelConfig
        const me = await this.callApi<TelegramUser>(
            credentials.botToken,
            'getMe',
            {}
        )
        const secret =
            credentials.webhookSecret ?? randomBytes(24).toString('hex')
        await this.callApi(credentials.botToken, 'setWebhook', {
            url: inboundUrl,
            secret_token: secret,
            allowed_updates: ['message', 'edited_message', 'callback_query'],
            drop_pending_updates: true
        })
        let message = `webhook registered for @${me.username ?? me.first_name ?? 'bot'}`
        try {
            await this.callApi(credentials.botToken, 'setMyCommands', {
                commands: SLASH_COMMAND_SPECS.map((spec) => ({
                    command: spec.name,
                    description: spec.description
                }))
            })
        } catch (err) {
            const detail = (err as Error).message
            message += `\n⚠ setMyCommands failed: ${detail} — command menu unavailable, chat still works`
            this.logger.warn(
                `setMyCommands failed for channel=${ctx.channel.id}: ${detail}`
            )
        }
        const configPatch: TelegramChannelConfig = {
            ...config,
            botUsername: me.username ?? config.botUsername ?? null
        }
        const credentialsPatch: TelegramChannelCredentials = {
            botToken: credentials.botToken,
            webhookSecret: secret
        }
        return {
            ok: true,
            activate: true,
            configPatch,
            credentialsPatch,
            message
        }
    }

    async unregister(ctx: ChannelContext): Promise<void> {
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        if (!credentials?.botToken) return
        await this.callApi(credentials.botToken, 'deleteWebhook', {
            drop_pending_updates: true
        }).catch((err) => {
            this.logger.warn(
                `deleteWebhook failed for channel=${ctx.channel.id}: ${(err as Error).message}`
            )
        })
        await this.callApi(credentials.botToken, 'deleteMyCommands', {}).catch(
            (err) => {
                this.logger.warn(
                    `deleteMyCommands failed for channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            }
        )
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        const expected = credentials?.webhookSecret
        if (!expected) return { ok: false, reason: 'webhook_secret_missing' }
        const provided =
            req.headers['x-telegram-bot-api-secret-token'] ??
            req.headers['X-Telegram-Bot-Api-Secret-Token']
        if (provided && provided === expected) return { ok: true }
        return { ok: false, reason: 'signature_mismatch' }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const config = ctx.config as TelegramChannelConfig
        const update = (req.body ?? {}) as TelegramUpdate
        const message = update.message ?? update.edited_message
        if (!message) throw new UnsupportedEventError('non_message_update')
        const attachments = telegramAttachmentsFromMessage(message)
        const rawText = message.text ?? message.caption
        if (
            (typeof rawText !== 'string' || rawText.trim().length === 0) &&
            attachments.length === 0
        )
            throw new UnsupportedEventError('empty_text_message')
        const normalizedText = typeof rawText === 'string' ? rawText : ''
        const sender = message.from
        if (!sender)
            throw new BadRequestException('telegram message missing from')
        const chatType: 'private' | 'group' =
            message.chat.type === 'private' ? 'private' : 'group'
        const isMention =
            chatType === 'group'
                ? mentionsBot(
                      normalizedText,
                      message.entities,
                      config.botUsername
                  )
                : true
        const text = stripBotCommandSuffix(normalizedText, config.botUsername)
        const threadId =
            chatType === 'group' && message.message_thread_id
                ? String(message.message_thread_id)
                : message.reply_to_message
                  ? String(message.reply_to_message.message_id)
                  : null
        return {
            providerEventId: `telegram-${update.update_id ?? message.message_id}`,
            chatId: String(message.chat.id),
            chatType,
            senderId: String(sender.id),
            senderName: sender.username ?? sender.first_name ?? null,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            threadId,
            isMention,
            messageId:
                message.message_id !== undefined
                    ? String(message.message_id)
                    : null,
            replyToMessageId: message.reply_to_message
                ? String(message.reply_to_message.message_id)
                : null,
            // Native-reply anchor for the eventual answer. DMs skip it: a
            // reply to the only other participant is pure noise.
            replyTargetId:
                chatType === 'group' && message.message_id !== undefined
                    ? String(message.message_id)
                    : null,
            raw: update
        }
    }

    parseInboundAction(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundAction | null {
        const update = (req.body ?? {}) as TelegramUpdate
        const callback = update.callback_query
        if (!callback?.id) return null
        // Clear the client-side button spinner regardless of whether the
        // payload maps to a known action; this parse hook is synchronous, so
        // the ack has to be fire-and-forget.
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        if (credentials?.botToken)
            void this.callApi(credentials.botToken, 'answerCallbackQuery', {
                callback_query_id: callback.id
            }).catch((err) => {
                this.logger.warn(
                    `answerCallbackQuery failed channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            })
        const verb = parseTelegramCallbackData(callback.data)
        const message = callback.message
        const sender = callback.from
        if (!verb || !message || !sender) return null
        const chatType: 'private' | 'group' =
            message.chat.type === 'private' ? 'private' : 'group'
        // Mirror parseInbound's thread derivation so the recomputed scope key
        // matches the session the button message lives in.
        const threadId =
            chatType === 'group' && message.message_thread_id
                ? String(message.message_thread_id)
                : message.reply_to_message
                  ? String(message.reply_to_message.message_id)
                  : null
        return {
            providerEventId: `telegram-cb-${callback.id}`,
            chatId: String(message.chat.id),
            chatType,
            senderId: String(sender.id),
            senderName: sender.username ?? sender.first_name ?? null,
            threadId,
            action: verb.action,
            targetChannelSessionId: verb.sessionId,
            targetPage: verb.page,
            scopeKey: null,
            raw: update
        }
    }

    async sendCommandView(
        ctx: ChannelContext,
        scopeKey: string,
        view: ChannelCommandView
    ): Promise<{ providerMessageId?: string }> {
        if (view.kind === 'text')
            return this.sendText(ctx, scopeKey, view.text, {
                nonConversational: true
            })
        const credentials = this.requireCredentials(ctx)
        const target = telegramTargetFromScopeKey(scopeKey)
        const keyboard =
            view.kind === 'session_list'
                ? sessionListKeyboard(view)
                : sessionDetailKeyboard(view)
        const res = await this.callHtmlApi<TelegramMessage>(
            credentials.botToken,
            'sendMessage',
            {
                chat_id: target.chatId,
                ...(target.threadRootId
                    ? { reply_to_message_id: Number(target.threadRootId) }
                    : {}),
                ...(keyboard
                    ? { reply_markup: { inline_keyboard: keyboard } }
                    : {})
            },
            view.text
        )
        return { providerMessageId: String(res.message_id) }
    }

    async fetchReplyContext(
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<string | null> {
        if (!event.replyToMessageId) return null
        const update = event.raw as TelegramUpdate | undefined
        const message = update?.message ?? update?.edited_message
        const replied = message?.reply_to_message
        if (!replied) return null
        const config = ctx.config as TelegramChannelConfig
        const bot = config.botUsername?.replace(/^@/, '').toLowerCase()
        // The bot's own replies are already in the transcript; quoting them
        // back would only duplicate context.
        if (
            replied.from?.is_bot &&
            bot &&
            replied.from.username?.toLowerCase() === bot
        )
            return null
        const snippet =
            message?.quote?.text ??
            replied.text ??
            replied.caption ??
            telegramMediaPlaceholder(replied)
        if (!snippet) return null
        const label =
            replied.from?.username ?? replied.from?.first_name ?? 'unknown'
        return `[Replying to "${label}"]: "${truncateForPreview(snippet, 200)}"`
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const fileId = parseTelegramFileUrl(attachment.url)
        const credentials = this.requireCredentials(ctx)
        const file = await this.callApi<TelegramFileInfo>(
            credentials.botToken,
            'getFile',
            { file_id: fileId }
        )
        if (!file.file_path)
            throw new Error('telegram getFile returned no file_path')
        if (
            typeof file.file_size === 'number' &&
            file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES
        )
            throw new Error('telegram file exceeds the 20 MB download limit')
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            TELEGRAM_DOWNLOAD_TIMEOUT_MS
        )
        try {
            const filePath = file.file_path.replace(/^\/+/, '')
            const response = await fetch(
                `${TELEGRAM_API_BASE}/file/bot${credentials.botToken}/${filePath}`,
                { method: 'GET', signal: controller.signal }
            )
            if (!response.ok)
                throw new Error(
                    `telegram file download failed: http ${response.status}`
                )
            const bytes = await readCappedTelegramBody(
                response,
                Math.min(opts.maxBytes, TELEGRAM_MAX_DOWNLOAD_BYTES)
            )
            return {
                name: attachment.name,
                contentType:
                    response.headers
                        .get('content-type')
                        ?.split(';')[0]
                        ?.trim() ||
                    attachment.contentType ||
                    'application/octet-stream',
                bytes
            }
        } finally {
            clearTimeout(timer)
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: TelegramChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        if (event.chatType === 'private')
            return {
                scopeKey: `telegram:${event.chatId}:${event.senderId}`,
                scopeName: event.senderName ?? null
            }
        if (event.threadId && config.threadIsolation)
            return {
                scopeKey: `telegram:${event.chatId}:thread:${event.threadId}`,
                scopeName: null
            }
        if (config.shareSessionInChannel)
            return {
                scopeKey: `telegram:${event.chatId}`,
                scopeName: null
            }
        return {
            scopeKey: `telegram:${event.chatId}:${event.senderId}`,
            scopeName: event.senderName ?? null
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: TelegramChannelConfig
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
            return {
                allowed: false,
                reason: 'chat_not_allowed',
                operator
            }
        const allowed =
            allowedUserIds.length === 0 ||
            allowedUserIds.includes(event.senderId) ||
            operator
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    // Bots may only react with Telegram's fixed free-emoji set, which has no
    // checkmark: 'working' pins eye-emoji, terminal states clear it (the reply
    // itself signals the outcome).
    async setInboundReaction(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const target = telegramTargetFromScopeKey(scopeKey)
        await this.callApi(credentials.botToken, 'setMessageReaction', {
            chat_id: target.chatId,
            message_id: Number(providerMessageId),
            reaction:
                state === 'working'
                    ? [{ type: 'emoji', emoji: '\u{1F440}' }]
                    : []
        })
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: { triggerProviderMessageId?: string | null }
    ): Promise<() => void> {
        const credentials = this.requireCredentials(ctx)
        const config = ctx.config as TelegramChannelConfig
        const target = telegramTargetFromScopeKey(scopeKey)
        // Reply-chain scopes carry a plain message id as the thread root;
        // sendChatAction only accepts real forum topic ids, so downgrade to
        // chat-level typing on the first rejection.
        let includeThread = target.threadRootId !== null
        let warned = false
        const fire = (): void => {
            void this.callApi(credentials.botToken, 'sendChatAction', {
                chat_id: target.chatId,
                action: 'typing',
                ...(includeThread
                    ? { message_thread_id: Number(target.threadRootId) }
                    : {})
            }).catch((err) => {
                if (includeThread) {
                    includeThread = false
                    fire()
                    return
                }
                if (warned) return
                warned = true
                this.logger.warn(
                    `telegram typing failed channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            })
        }
        fire()
        const interval = setInterval(fire, TYPING_REFRESH_MS)
        interval.unref?.()
        const ackMessageId =
            config.ackReaction === true && opts?.triggerProviderMessageId
                ? Number(opts.triggerProviderMessageId)
                : null
        if (ackMessageId !== null)
            void this.callApi(credentials.botToken, 'setMessageReaction', {
                chat_id: target.chatId,
                message_id: ackMessageId,
                reaction: [{ type: 'emoji', emoji: '👀' }]
            }).catch(() => undefined)
        let stopped = false
        const stop = (): void => {
            if (stopped) return
            stopped = true
            clearInterval(interval)
            clearTimeout(cap)
            if (ackMessageId !== null)
                void this.callApi(credentials.botToken, 'setMessageReaction', {
                    chat_id: target.chatId,
                    message_id: ackMessageId,
                    reaction: []
                }).catch(() => undefined)
        }
        const cap = setTimeout(stop, TYPING_MAX_MS)
        cap.unref?.()
        return stop
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }> {
        const credentials = this.requireCredentials(ctx)
        const target = telegramTargetFromScopeKey(scopeKey)
        const chunks = chunkText(wrapMarkdownTables(text), MAX_MESSAGE_LEN)
        let lastId: string | undefined
        for (let i = 0; i < chunks.length; i += 1) {
            const res = await this.callHtmlApi<TelegramMessage>(
                credentials.botToken,
                'sendMessage',
                {
                    chat_id: target.chatId,
                    ...telegramSendAnchor(target, opts, i)
                },
                chunks[i]
            )
            lastId = String(res.message_id)
        }
        return { providerMessageId: lastId }
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const credentials = this.requireCredentials(ctx)
        const dest = telegramDirectDestination(target)
        const chunks = chunkText(wrapMarkdownTables(text), MAX_MESSAGE_LEN)
        let lastId: string | undefined
        for (let i = 0; i < chunks.length; i += 1) {
            const res = await this.callHtmlApi<TelegramMessage>(
                credentials.botToken,
                'sendMessage',
                {
                    chat_id: dest.chatId,
                    ...(i === 0 && dest.replyToMessageId
                        ? {
                              reply_parameters: {
                                  message_id: Number(dest.replyToMessageId),
                                  allow_sending_without_reply: true
                              }
                          }
                        : {})
                },
                chunks[i]
            )
            lastId = String(res.message_id)
        }
        return { providerMessageId: lastId }
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        if (files.length === 0) return {}
        const target = telegramTargetFromScopeKey(scopeKey)
        const fields: Record<string, string> = { chat_id: target.chatId }
        if (target.threadRootId)
            fields.message_thread_id = target.threadRootId
        return this.postAttachments(ctx, files, () => fields)
    }

    async sendDirectAttachments(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        if (files.length === 0) return {}
        const dest = telegramDirectDestination(target)
        return this.postAttachments(ctx, files, (index) => ({
            chat_id: dest.chatId,
            ...(index === 0 && dest.replyToMessageId
                ? {
                      reply_parameters: JSON.stringify({
                          message_id: Number(dest.replyToMessageId),
                          allow_sending_without_reply: true
                      })
                  }
                : {})
        }))
    }

    private async postAttachments(
        ctx: ChannelContext,
        files: OutboundAttachment[],
        fieldsFor: (index: number) => Record<string, string>
    ): Promise<{ providerMessageId?: string }> {
        const credentials = this.requireCredentials(ctx)
        let lastId: string | undefined
        for (let i = 0; i < files.length; i += 1) {
            const file = files[i]
            const buildForm = (field: 'photo' | 'document'): FormData => {
                const form = new FormData()
                for (const [key, value] of Object.entries(fieldsFor(i)))
                    form.append(key, value)
                form.append(
                    field,
                    new Blob([new Uint8Array(file.bytes)], {
                        type: file.contentType
                    }),
                    file.name
                )
                return form
            }
            const asDocument = (): Promise<TelegramMessage> =>
                this.callApiMultipart<TelegramMessage>(
                    credentials.botToken,
                    'sendDocument',
                    buildForm('document')
                )
            let sent: TelegramMessage
            if (file.contentType.startsWith('image/')) {
                // sendPhoto re-encodes and rejects large or oddly-sized
                // images; the original file is still deliverable as a document.
                sent = await this.callApiMultipart<TelegramMessage>(
                    credentials.botToken,
                    'sendPhoto',
                    buildForm('photo')
                ).catch((err) => {
                    this.logger.warn(
                        `sendPhoto failed for channel=${ctx.channel.id}, retrying as document: ${(err as Error).message}`
                    )
                    return asDocument()
                })
            } else {
                sent = await asDocument()
            }
            lastId = String(sent.message_id)
        }
        return { providerMessageId: lastId }
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: SendTextOptions
    ): Promise<PreviewHandle> {
        const credentials = this.requireCredentials(ctx)
        const target = telegramTargetFromScopeKey(scopeKey)
        const res = await this.callApi<TelegramMessage>(
            credentials.botToken,
            'sendMessage',
            {
                chat_id: target.chatId,
                text: '⏳ thinking…',
                ...telegramSendAnchor(target, opts, 0)
            }
        )
        return {
            providerMessageId: String(res.message_id),
            raw: { chatId: target.chatId }
        }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const chatId = (handle.raw as { chatId?: string } | undefined)?.chatId
        if (!chatId) return
        const text = truncateForPreview(
            wrapMarkdownTables(partial),
            MAX_MESSAGE_LEN - 32
        )
        await this.callHtmlApi(
            credentials.botToken,
            'editMessageText',
            {
                chat_id: chatId,
                message_id: Number(handle.providerMessageId)
            },
            text,
            '<i>⏳ streaming…</i>',
            '⏳ streaming…'
        ).catch((err) => {
            this.logger.warn(
                `editMessageText (preview) failed: ${(err as Error).message}`
            )
        })
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const chatId = (handle.raw as { chatId?: string } | undefined)?.chatId
        if (!chatId) return
        const chunks = chunkText(wrapMarkdownTables(finalText), MAX_MESSAGE_LEN)
        const head = chunks[0] ?? '(empty)'
        await this.callHtmlApi(
            credentials.botToken,
            'editMessageText',
            {
                chat_id: chatId,
                message_id: Number(handle.providerMessageId)
            },
            head
        ).catch(async (err) => {
            this.logger.warn(
                `editMessageText (final) failed, falling back to sendMessage: ${(err as Error).message}`
            )
            await this.callHtmlApi(
                credentials.botToken,
                'sendMessage',
                { chat_id: chatId },
                head
            )
        })
        for (let i = 1; i < chunks.length; i += 1) {
            await this.callHtmlApi(
                credentials.botToken,
                'sendMessage',
                { chat_id: chatId },
                chunks[i]
            )
        }
    }

    async deleteMessage(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const target = telegramTargetFromScopeKey(scopeKey)
        await this.callApi(credentials.botToken, 'deleteMessage', {
            chat_id: target.chatId,
            message_id: Number(providerMessageId)
        })
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        if (!credentials?.botToken)
            return { ok: false, message: '✗ botToken missing' }
        const lines: string[] = []
        let ok = true
        try {
            const me = await this.callApi<TelegramUser>(
                credentials.botToken,
                'getMe',
                {}
            )
            lines.push(
                `✓ bot identity: @${me.username ?? me.first_name ?? me.id}`
            )
        } catch (err) {
            return {
                ok: false,
                message: `✗ getMe failed: ${(err as Error).message}`
            }
        }
        try {
            const info = await this.callApi<TelegramWebhookInfo>(
                credentials.botToken,
                'getWebhookInfo',
                {}
            )
            const expectedSuffix = `/api/channels/hooks/telegram/${ctx.channel.id}`
            if (info.url && info.url.endsWith(expectedSuffix))
                lines.push(
                    `✓ webhook is set${info.pending_update_count ? ` (${info.pending_update_count} pending)` : ''}`
                )
            else {
                ok = false
                lines.push(
                    `✗ webhook URL does not match — expected suffix ${expectedSuffix}, got ${info.url || '(none)'}`
                )
            }
            if (info.last_error_message) {
                const errAge = info.last_error_date
                    ? Date.now() / 1000 - info.last_error_date
                    : null
                const ageStr =
                    errAge === null
                        ? ''
                        : errAge < 60
                          ? ` (${Math.round(errAge)}s ago)`
                          : errAge < 3600
                            ? ` (${Math.round(errAge / 60)}m ago)`
                            : ` (${Math.round(errAge / 3600)}h ago)`
                if (errAge !== null && errAge > 5 * 60)
                    lines.push(
                        `ℹ Telegram's last delivery error${ageStr}: ${info.last_error_message}`,
                        `  (likely stale — Telegram clears it on the next successful delivery; send a message to the bot to confirm)`
                    )
                else {
                    ok = false
                    lines.push(
                        `✗ Telegram reports recent webhook error${ageStr}: ${info.last_error_message}`
                    )
                }
            }
        } catch (err) {
            ok = false
            lines.push(`✗ getWebhookInfo failed: ${(err as Error).message}`)
        }
        return { ok, message: lines.join('\n') }
    }

    private requireCredentials(
        ctx: ChannelContext
    ): TelegramChannelCredentials {
        const credentials = ctx.credentials as TelegramChannelCredentials | null
        if (!credentials?.botToken)
            throw new BadRequestException('telegram botToken missing')
        return credentials
    }

    private async callApi<T = Record<string, unknown>>(
        botToken: string,
        method: string,
        params: Record<string, unknown>
    ): Promise<T> {
        return this.requestTelegram(method, () =>
            channelProviderJsonRequest<TelegramApiEnvelope<T>>({
                provider: 'telegram',
                operation: method,
                url: `${TELEGRAM_API_BASE}/bot${botToken}/${method}`,
                init: {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify(params)
                }
            })
        )
    }

    // Telegram flood control answers 429 with parameters.retry_after; honor
    // it once so a chunked send doesn't fail midway and get redelivered from
    // scratch (duplicating the chunks that already went out).
    private async requestTelegram<T>(
        method: string,
        perform: () => Promise<
            ChannelProviderJsonResponse<TelegramApiEnvelope<T>>
        >
    ): Promise<T> {
        let res = await perform()
        if (res.status === 429) {
            const retryAfter = res.json?.parameters?.retry_after
            const waitSeconds = Math.min(
                Math.max(typeof retryAfter === 'number' ? retryAfter : 1, 0),
                30
            )
            await sleep(waitSeconds * 1000)
            res = await perform()
        }
        const json = res.json ?? {}
        if (!res.ok || json.ok !== true) {
            const description = json.description ?? res.text.slice(0, 300)
            // Keep the "<status> <description>" shape: isTelegramMarkupError
            // matches it to drive the plain-text fallback in callHtmlApi.
            const message = `telegram ${method} failed: ${res.status} ${description}`
            const kind = classifyTelegramFailure(res.status, description)
            if (kind === null) throw new Error(message)
            throw new ChannelSendError(kind, message, {
                retryAfterMs:
                    kind === 'rate_limited'
                        ? typeof json.parameters?.retry_after === 'number'
                            ? json.parameters.retry_after * 1000
                            : res.retryAfterMs
                        : null
            })
        }
        return json.result as T
    }

    private async callHtmlApi<T = Record<string, unknown>>(
        botToken: string,
        method: string,
        params: Record<string, unknown>,
        markdown: string,
        htmlSuffix?: string,
        plainSuffix?: string
    ): Promise<T> {
        const html = markdownToTelegramHtml(markdown)
        const htmlText = htmlSuffix ? `${html}\n\n${htmlSuffix}` : html
        try {
            return await this.callApi<T>(botToken, method, {
                ...params,
                text: htmlText,
                parse_mode: 'HTML'
            })
        } catch (err) {
            if (!isTelegramMarkupError((err as Error).message)) throw err
            const plainText = plainSuffix
                ? `${markdown}\n\n${plainSuffix}`
                : markdown
            return this.callApi<T>(botToken, method, {
                ...params,
                text: plainText
            })
        }
    }

    private async callApiMultipart<T = Record<string, unknown>>(
        botToken: string,
        method: string,
        form: FormData
    ): Promise<T> {
        return this.requestTelegram(method, () =>
            channelProviderJsonRequest<TelegramApiEnvelope<T>>({
                provider: 'telegram',
                operation: method,
                url: `${TELEGRAM_API_BASE}/bot${botToken}/${method}`,
                init: { method: 'POST', body: form }
            })
        )
    }
}

interface TelegramUser {
    id: number
    is_bot: boolean
    first_name?: string
    username?: string
}

interface TelegramWebhookInfo {
    url: string
    pending_update_count?: number
    last_error_message?: string
    last_error_date?: number
}

interface TelegramFileInfo {
    file_id: string
    file_unique_id?: string
    file_size?: number
    file_path?: string
}

interface TelegramApiEnvelope<T> {
    ok?: boolean
    result?: T
    description?: string
    parameters?: { retry_after?: number }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const BOT_COMMAND_SUFFIX_RE = /^\/([a-zA-Z0-9_]+)@([a-zA-Z0-9_]+)([\s\S]*)$/

// Telegram inserts `/cmd@BotName` when a command is picked in a group (and
// often in DMs too). Strip the suffix when it targets this bot so the slash
// parser sees a clean `/cmd`; leave it untouched for a different bot so the
// mention gate drops it.
const stripBotCommandSuffix = (
    text: string,
    botUsername: string | null | undefined
): string => {
    if (!botUsername) return text
    const match = BOT_COMMAND_SUFFIX_RE.exec(text)
    if (!match) return text
    const bot = botUsername.replace(/^@/, '')
    if (match[2].toLowerCase() !== bot.toLowerCase()) return text
    return `/${match[1]}${match[3]}`
}

const mentionsBot = (
    text: string,
    entities: TelegramMessage['entities'],
    botUsername: string | null | undefined
): boolean => {
    if (!botUsername) return false
    const handle = `@${botUsername.replace(/^@/, '')}`
    if (text.includes(handle)) return true
    if (!entities) return false
    return entities.some((e) => {
        if (e.type !== 'mention' && e.type !== 'text_mention') return false
        const mentionText = text.slice(e.offset, e.offset + e.length)
        return mentionText === handle
    })
}

const telegramTargetFromScopeKey = (
    scopeKey: string
): { chatId: string; threadRootId: string | null } => {
    const segments = scopeKey.split(':')
    if (segments.length < 2) throw new Error(`invalid scopeKey ${scopeKey}`)
    return {
        chatId: segments[1],
        threadRootId:
            segments[2] === 'thread' && segments[3] ? segments[3] : null
    }
}

const truncateForPreview = (text: string, max: number): string => {
    if (text.length <= max) return text
    return `${text.slice(0, max - 1)}…`
}

// First chunk answers as a native reply when the bridge passed a target (the
// reply implicitly lands in the right topic); everything else falls back to
// the legacy thread-root anchor so forum chunks stay inside their topic.
const telegramSendAnchor = (
    target: { chatId: string; threadRootId: string | null },
    opts: SendTextOptions | undefined,
    chunkIndex: number
): Record<string, unknown> => {
    const replyTo = opts?.replyToProviderMessageId
    if (chunkIndex === 0 && replyTo)
        return {
            reply_parameters: {
                message_id: Number(replyTo),
                allow_sending_without_reply: true
            }
        }
    if (target.threadRootId)
        return { reply_to_message_id: Number(target.threadRootId) }
    return {}
}

interface TelegramInlineButton {
    text: string
    callback_data: string
}

const TELEGRAM_BUTTON_LABEL_MAX = 48

// callback_data is capped at 64 bytes, so the verbs stay terse: mf|sw|<id>,
// mf|del|<id>, mf|pg|<n>, mf|new, mf|cur. The scope is NOT encoded — the
// bridge recomputes it from the callback message, and slash handlers only
// match sessions inside that scope.
const parseTelegramCallbackData = (
    data: string | undefined
): {
    action: string
    sessionId: string | null
    page: number | null
} | null => {
    if (!data?.startsWith('mf|')) return null
    const [, verb, arg] = data.split('|')
    if (verb === 'new')
        return { action: 'act:/new-session', sessionId: null, page: null }
    if (verb === 'cur')
        return { action: 'nav:/current', sessionId: null, page: null }
    if (verb === 'sw' && arg)
        return { action: 'act:/switch-session', sessionId: arg, page: null }
    if (verb === 'del' && arg)
        return { action: 'act:/delete-session', sessionId: arg, page: null }
    if (verb === 'pg') {
        const page = Number(arg)
        if (Number.isInteger(page) && page > 0)
            return { action: 'nav:/list-page', sessionId: null, page }
    }
    return null
}

const sessionListKeyboard = (view: {
    items: Array<{
        index: number
        channelSessionId: string
        displayName: string | null
        chatTitle: string | null
        isActive: boolean
    }>
    page: { current: number; total: number }
}): TelegramInlineButton[][] => {
    const rows = view.items.map((item) => [
        {
            text: truncateForPreview(
                `${item.isActive ? '● ' : ''}${item.index}. ${item.displayName ?? item.chatTitle ?? 'session'}`,
                TELEGRAM_BUTTON_LABEL_MAX
            ),
            callback_data: `mf|sw|${item.channelSessionId}`
        }
    ])
    const nav: TelegramInlineButton[] = []
    if (view.page.current > 1)
        nav.push({
            text: '‹ Prev',
            callback_data: `mf|pg|${view.page.current - 1}`
        })
    if (view.page.current < view.page.total)
        nav.push({
            text: 'Next ›',
            callback_data: `mf|pg|${view.page.current + 1}`
        })
    if (nav.length > 0) rows.push(nav)
    rows.push([{ text: '＋ New session', callback_data: 'mf|new' }])
    return rows
}

const sessionDetailKeyboard = (view: {
    item: { channelSessionId: string; isActive: boolean } | null
}): TelegramInlineButton[][] | null =>
    view.item
        ? [
              [
                  ...(view.item.isActive
                      ? []
                      : [
                            {
                                text: 'Switch to this session',
                                callback_data: `mf|sw|${view.item.channelSessionId}`
                            }
                        ]),
                  {
                      text: 'Delete',
                      callback_data: `mf|del|${view.item.channelSessionId}`
                  }
              ]
          ]
        : null

// Telegram private chats share the user's id, so a user target sends to
// chat_id = userId (fails if the user never started the bot). A reply target
// must carry the chat explicitly — Telegram message ids are per-chat.
const telegramDirectDestination = (
    target: ChannelSendTarget
): { chatId: string; replyToMessageId: string | null } => {
    if (target.kind === 'chat')
        return { chatId: target.chatId, replyToMessageId: null }
    if (target.kind === 'user')
        return { chatId: target.userId, replyToMessageId: null }
    const separator = target.messageId.lastIndexOf(':')
    const chatId =
        separator > 0 ? target.messageId.slice(0, separator) : ''
    const messageId =
        separator > 0 ? target.messageId.slice(separator + 1) : ''
    if (!chatId || !messageId || !/^\d+$/.test(messageId))
        throw new BadRequestException(
            'telegram reply target must be "<chatId>:<messageId>"'
        )
    return { chatId, replyToMessageId: messageId }
}

const telegramMediaPlaceholder = (message: TelegramMessage): string | null => {
    if (message.photo?.length) return '[photo]'
    if (message.document)
        return `[file: ${message.document.file_name ?? 'document'}]`
    if (message.voice) return '[voice message]'
    if (message.audio) return '[audio]'
    if (message.video) return '[video]'
    return null
}

const telegramAttachmentsFromMessage = (
    message: TelegramMessage
): NormalizedInboundAttachment[] => {
    const attachments: NormalizedInboundAttachment[] = []
    const add = (
        file: TelegramFile | undefined,
        fallbackName: string,
        fallbackContentType: string
    ): void => {
        if (!file?.file_id) return
        // Oversized files stay in the descriptor list on purpose: the bridge
        // size gate / downloadAttachment reject them with a recorded skip and
        // a user-visible degraded notice instead of a silent drop here.
        attachments.push({
            url: `${TELEGRAM_FILE_PREFIX}${file.file_id}`,
            name: file.file_name ?? fallbackName,
            contentType: file.mime_type ?? fallbackContentType,
            size: file.file_size ?? null
        })
    }

    const photo = message.photo?.reduce<TelegramPhotoSize | undefined>(
        (largest, candidate) => {
            if (!largest) return candidate
            return candidate.width * candidate.height >
                largest.width * largest.height
                ? candidate
                : largest
        },
        undefined
    )
    add(photo, photo ? `photo-${photo.file_id}.jpg` : 'photo.jpg', 'image/jpeg')
    add(
        message.document,
        message.document ? `document-${message.document.file_id}` : 'document',
        'application/octet-stream'
    )
    add(
        message.voice,
        message.voice ? `voice-${message.voice.file_id}.ogg` : 'voice.ogg',
        'audio/ogg'
    )
    add(
        message.audio,
        message.audio ? `audio-${message.audio.file_id}.mp3` : 'audio.mp3',
        'audio/mpeg'
    )
    add(
        message.video,
        message.video ? `video-${message.video.file_id}.mp4` : 'video.mp4',
        'video/mp4'
    )
    return attachments
}

// Positive identification only: anything not listed stays a plain Error and
// keeps today's ladder-retry path. Markup rejections are deliberately not
// classified — callHtmlApi retries them as plain text first, and only an
// unrecognizable failure of that fallback should surface.
const classifyTelegramFailure = (
    status: number,
    description: string
): ChannelSendErrorKind | null => {
    if (status === 429) return 'rate_limited'
    if (status === 403) return 'forbidden'
    if (status === 400) {
        if (/message is too long/i.test(description)) return 'too_long'
        if (/chat not found|PEER_ID_INVALID|user not found/i.test(description))
            return 'not_found'
    }
    return null
}

// Telegram phrases HTML rejections in several ways ("can't parse entities",
// "unsupported start tag", URL/protocol complaints); all of them mean the
// rendered markup — not the message — is the problem, so plain text can
// still go through.
const isTelegramMarkupError = (message: string): boolean =>
    /\b400\b/.test(message) &&
    /(can't parse entities|unsupported start tag|wrong HTTP URL|unsupported URL protocol)/i.test(
        message
    )

const parseTelegramFileUrl = (url: string): string => {
    if (!url.startsWith(TELEGRAM_FILE_PREFIX))
        throw new Error('telegram attachment url is not a telegram-file url')
    const fileId = url.slice(TELEGRAM_FILE_PREFIX.length)
    if (!fileId) throw new Error('telegram attachment file id is empty')
    return fileId
}

const readCappedTelegramBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > maxBytes)
            throw new Error(`telegram file exceeds ${maxBytes} bytes`)
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
            throw new Error(`telegram file exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}

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
