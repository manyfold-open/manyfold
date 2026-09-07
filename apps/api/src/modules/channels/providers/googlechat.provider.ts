import type {
    ChannelTestResult,
    GoogleChatAudienceType,
    GoogleChatChannelConfig,
    GoogleChatChannelCredentials
} from '@manyfold/shared'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHandle,
    type ChannelProvider,
    type InboundActorPolicy,
    type InboundRequest,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type PreviewHandle,
    type RegistrationResult,
    type SignatureCheck
} from '../channel-provider'
import { channelProviderJsonRequest } from './channel-http'
import {
    ChannelSendError,
    type ChannelSendErrorKind
} from '../channel-send-error'
import { parseProgressMode, parseResetOnIdleMins } from '../config-helpers'
import { chunkText, wrapMarkdownTables } from '../text-chunk'
import { markdownToGoogleChat } from './googlechat-format'
import {
    getGoogleChatAccessToken,
    invalidateGoogleChatAccessToken,
    parseGoogleChatServiceAccount,
    verifyGoogleChatToken,
    type GoogleChatServiceAccount
} from './googlechat-auth'

const CHAT_API_BASE = 'https://chat.googleapis.com/v1'
// Google documents no size limit on Message.text (the 32 KB cap it does state
// is for cardsV2). This is a readability budget, in line with Slack's 3800 and
// LINE's 5000, and stays under 32 KB even at 4 UTF-8 bytes per character.
const GOOGLE_CHAT_MAX_TEXT_LEN = 4000
// Chat allows one write per second per space, shared with every other Chat app
// in that space. Leave headroom rather than riding the limit exactly.
const SPACE_WRITE_GAP_MS = 1100
const SPACE_CHAIN_MAX = 4096
const MEDIA_PREFIX = 'googlechat-media:'
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000

// Positive identification only — anything unlisted keeps the generic Error and
// today's ladder-retry path. UNAUTHENTICATED is deliberately absent: a 401 here
// is usually a token minted before a credential rotation, and 'forbidden' would
// dead-letter the delivery instead of letting a re-mint deliver it.
const GOOGLE_CHAT_ERROR_KINDS: Record<string, ChannelSendErrorKind> = {
    RESOURCE_EXHAUSTED: 'rate_limited',
    PERMISSION_DENIED: 'forbidden',
    NOT_FOUND: 'not_found',
    INVALID_ARGUMENT: 'bad_format',
    FAILED_PRECONDITION: 'bad_format',
    UNAVAILABLE: 'transient',
    DEADLINE_EXCEEDED: 'transient',
    ABORTED: 'transient'
}

const HTTP_ERROR_KINDS: Record<number, ChannelSendErrorKind> = {
    400: 'bad_format',
    403: 'forbidden',
    404: 'not_found',
    429: 'rate_limited',
    503: 'transient',
    504: 'transient'
}

export const classifyGoogleChatError = (
    status: number,
    rpcStatus: string | null
): ChannelSendErrorKind | null => {
    if (rpcStatus && GOOGLE_CHAT_ERROR_KINDS[rpcStatus])
        return GOOGLE_CHAT_ERROR_KINDS[rpcStatus]
    return HTTP_ERROR_KINDS[status] ?? null
}

interface GoogleChatUser {
    name?: string
    displayName?: string
    email?: string
    type?: string
}

interface GoogleChatAttachmentPayload {
    name?: string
    contentName?: string
    contentType?: string
    attachmentDataRef?: { resourceName?: string }
    driveDataRef?: { driveFileId?: string }
    source?: string
}

interface GoogleChatAnnotation {
    type?: string
    userMention?: { user?: GoogleChatUser; type?: string }
    slashCommand?: { commandId?: string; commandName?: string }
}

interface GoogleChatMessagePayload {
    name?: string
    sender?: GoogleChatUser
    text?: string
    argumentText?: string
    formattedText?: string
    thread?: { name?: string }
    threadReply?: boolean
    annotations?: GoogleChatAnnotation[]
    attachment?: GoogleChatAttachmentPayload[]
    slashCommand?: { commandId?: string }
}

interface GoogleChatSpacePayload {
    name?: string
    type?: string
    spaceType?: string
    displayName?: string
    singleUserBotDm?: boolean
}

interface GoogleChatEventBody {
    type?: string
    eventTime?: string
    space?: GoogleChatSpacePayload
    message?: GoogleChatMessagePayload
    user?: GoogleChatUser
}

interface GoogleChatMessageResponse {
    name?: string
    thread?: { name?: string }
}

@Injectable()
export class GoogleChatChannelProvider implements ChannelProvider {
    readonly name = 'googlechat' as const
    // A preview edit spends the same per-space write as the reply itself, so
    // stay at half the budget and leave room for a co-resident Chat app.
    readonly previewUpdateMinIntervalMs = 2000
    private readonly logger = new Logger(GoogleChatChannelProvider.name)
    // Serializes writes per space and holds them a beat apart. A chunked reply
    // fires back-to-back creates that would otherwise 429 each other — and
    // throttle unrelated Chat apps sharing the space.
    private readonly spaceWriteChain = new Map<string, Promise<unknown>>()
    private readonly lastSpaceWriteAt = new Map<string, number>()

    validateConfig(config: unknown): GoogleChatChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            audienceType: parseAudienceType(c.audienceType),
            audience:
                typeof c.audience === 'string' && c.audience.trim().length > 0
                    ? c.audience.trim()
                    : null,
            botUserId:
                typeof c.botUserId === 'string' && c.botUserId.trim().length > 0
                    ? c.botUserId.trim()
                    : null,
            botDisplayName:
                typeof c.botDisplayName === 'string' &&
                c.botDisplayName.trim().length > 0
                    ? c.botDisplayName.trim()
                    : null,
            allowedSpaceIds: stringList(c.allowedSpaceIds),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            threadIsolation: c.threadIsolation !== false,
            autoThread: c.autoThread !== false,
            // 'final' rather than the usual 'preview': see the field comment on
            // GoogleChatChannelConfig for the per-space write budget.
            progressMode: parseProgressMode(c.progressMode, 'final'),
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(
        credentials: unknown
    ): GoogleChatChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const raw = c.serviceAccountJson
        if (typeof raw !== 'string' || raw.trim().length === 0)
            throw new BadRequestException(
                'credentials.serviceAccountJson is required'
            )
        try {
            parseGoogleChatServiceAccount(raw)
        } catch (err) {
            throw new BadRequestException((err as Error).message)
        }
        return { serviceAccountJson: raw.trim() }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult> {
        const credentials =
            ctx.credentials as GoogleChatChannelCredentials | null
        if (!credentials?.serviceAccountJson)
            return { ok: false, message: 'serviceAccountJson missing' }
        const config = ctx.config as GoogleChatChannelConfig
        let sa: GoogleChatServiceAccount
        try {
            sa = parseGoogleChatServiceAccount(credentials.serviceAccountJson)
        } catch (err) {
            return { ok: false, message: (err as Error).message }
        }
        try {
            await this.callApi(ctx, sa, 'spaces.list', 'GET', '/spaces?pageSize=1')
        } catch (err) {
            return {
                ok: false,
                message: `service account check failed: ${(err as Error).message}`
            }
        }
        // In app-url mode the registered endpoint URL is literally the token's
        // aud claim, so prefill it from the URL Manyfold hands out rather than
        // making the operator retype it and risk a mismatch.
        const audience =
            config.audienceType === 'app-url'
                ? (config.audience ?? inboundUrl)
                : (config.audience ?? null)
        const configPatch: GoogleChatChannelConfig = { ...config, audience }
        // Activating without an audience would take the channel live in a state
        // where every inbound request fails verification, which reads as
        // "nothing arrives" rather than as a setup step left undone.
        if (!audience)
            return {
                ok: false,
                message:
                    'enter your Google Cloud project number as the audience, then register again',
                configPatch
            }
        const audienceNote =
            config.audienceType === 'app-url'
                ? `authentication audience (HTTP endpoint URL): ${audience}`
                : `authentication audience (project number): ${audience}`
        return {
            ok: true,
            // Chat has no verification handshake to flip the channel live, so
            // register() activates it once the credentials are proven — the
            // same contract Linear and GitHub use.
            activate: true,
            message: `service account ${sa.clientEmail} authenticated; ${audienceNote}`,
            configPatch
        }
    }

    async verifySignature(
        req: InboundRequest,
        ctx: ChannelContext
    ): Promise<SignatureCheck> {
        const config = ctx.config as GoogleChatChannelConfig
        const headers = lowercaseHeaders(req.headers)
        const authorization = headers['authorization'] ?? ''
        const token = authorization.toLowerCase().startsWith('bearer ')
            ? authorization.slice(7).trim()
            : ''
        if (!token) return { ok: false, reason: 'missing_bearer_token' }
        const audience = config.audience ?? ''
        const check = await verifyGoogleChatToken({
            token,
            audienceType: config.audienceType,
            audience
        })
        if (!check.ok)
            return { ok: false, reason: check.reason ?? 'token_invalid' }
        // Chat has no url_verification ping, so there is never a challenge to
        // answer; the channel is activated by register() instead.
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const config = ctx.config as GoogleChatChannelConfig
        const body = (req.body ?? {}) as GoogleChatEventBody
        const type = body.type
        if (!type) throw new UnsupportedEventError('unknown')
        if (type !== 'MESSAGE') throw new UnsupportedEventError(type)
        const message = body.message
        const space = body.space
        if (!message || !space?.name)
            throw new BadRequestException('missing message or space')
        const messageName = message.name
        if (!messageName) throw new BadRequestException('missing message name')
        const sender = message.sender ?? body.user
        const senderName = sender?.name
        if (!senderName) throw new BadRequestException('missing sender')
        // Chat echoes the app's own posts back; sender.type is the platform's
        // own answer, and botUserId covers a second app sharing the space.
        if (sender?.type === 'BOT')
            throw new UnsupportedEventError('bot_message')
        if (config.botUserId && senderName === config.botUserId)
            throw new UnsupportedEventError('self_message')

        const spaceId = resourceSuffix(space.name)
        if (!spaceId) throw new BadRequestException('missing space id')
        const chatType = isDirectMessage(space) ? 'private' : 'group'

        const slashCommandId =
            message.slashCommand?.commandId ??
            message.annotations?.find((a) => a.slashCommand)?.slashCommand
                ?.commandId ??
            null
        // argumentText already has the mention stripped, which is what we want
        // for chat — but a slash invocation needs the command back, so use the
        // raw text there.
        const rawText = slashCommandId
            ? (message.text ?? '')
            : (message.argumentText ?? message.text ?? '')
        const text = rawText.trim()

        const attachments = normalizeAttachments(message.attachment)
        if (text.length === 0 && attachments.length === 0)
            throw new UnsupportedEventError('empty_text')

        // Chat marks its own mention annotation with user.type BOT, so a
        // self-mention resolves without knowing our own user id (the same
        // affordance LINE gives via mentionees[].isSelf).
        const isMention =
            chatType === 'private' ||
            (message.annotations ?? []).some(
                (a) =>
                    a.type === 'USER_MENTION' &&
                    (a.userMention?.user?.type === 'BOT' ||
                        (config.botUserId !== null &&
                            config.botUserId !== undefined &&
                            a.userMention?.user?.name === config.botUserId))
            )

        const threadName = message.thread?.name ?? null
        const threadResourceId = threadName
            ? resourceSuffix(threadName)
            : null
        // Chat opens a thread for EVERY top-level message, so thread.name alone
        // is no evidence of a conversation. threadReply is the platform's own
        // answer to "is this actually in a thread".
        const isThreadReply = message.threadReply === true
        let threadId = isThreadReply ? threadResourceId : null
        if (
            threadId === null &&
            chatType === 'group' &&
            config.autoThread !== false &&
            config.threadIsolation &&
            (isMention || config.mentionOnly === false) &&
            !text.startsWith('/') &&
            threadResourceId
        )
            threadId = threadResourceId
        // Only meaningful once a thread was adopted rather than joined: it
        // tells history backfill there is nothing above this message.
        const threadFresh = threadId !== null && !isThreadReply

        return {
            // Chat redelivers a retried event with the same message name, so it
            // is the natural dedupe key.
            providerEventId: messageName,
            chatId: spaceId,
            chatType,
            senderId: resourceSuffix(senderName) ?? senderName,
            senderName: sender?.displayName ?? null,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            threadId,
            isMention,
            messageId: messageName,
            replyToMessageId: null,
            ...(threadFresh ? { threadFresh: true } : {}),
            ...(slashCommandId && text.startsWith('/')
                ? { commandInvocation: true }
                : {}),
            raw: body
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: GoogleChatChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        // Chat space ids carry no kind prefix, so state it explicitly. That
        // also puts the space at segment 2, matching the Slack shape.
        const kind = event.chatType === 'private' ? 'dm' : 'space'
        const base = `googlechat:${kind}:${event.chatId}`
        if (event.chatType === 'private') {
            if (event.threadId && config.threadIsolation)
                return {
                    scopeKey: `${base}:${event.senderId}:thread:${event.threadId}`,
                    scopeName: null
                }
            return { scopeKey: `${base}:${event.senderId}`, scopeName: null }
        }
        if (event.threadId && config.threadIsolation)
            return {
                scopeKey: `${base}:thread:${event.threadId}`,
                scopeName: null
            }
        if (config.shareSessionInChannel)
            return { scopeKey: base, scopeName: null }
        return { scopeKey: `${base}:${event.senderId}`, scopeName: null }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: GoogleChatChannelConfig
    ): InboundActorPolicy {
        const allowedSpaces = config.allowedSpaceIds ?? []
        if (allowedSpaces.length > 0 && !allowedSpaces.includes(event.chatId))
            return { allowed: false, reason: 'space_not_allowed', operator: false }
        // An operator may be listed by email or by users/{id}; the event knows
        // the id, and the email only exists on the raw payload.
        const identities = actorIdentities(event)
        const operator = (config.operatorUserIds ?? []).some((id) =>
            identities.has(normalizeActorId(id))
        )
        const allowedIds = config.allowedUserIds ?? []
        // Operators implicitly hold chat permission, or an operator on a
        // channel with a non-empty allowlist would have /model dropped by the
        // chat gate before dispatch could check operator rights.
        const allowed =
            allowedIds.length === 0 ||
            operator ||
            allowedIds.some((id) => identities.has(normalizeActorId(id)))
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const sa = this.requireServiceAccount(ctx)
        const target = googleChatTargetFromScopeKey(scopeKey)
        const chunks = chunkText(
            markdownToGoogleChat(wrapMarkdownTables(text)),
            GOOGLE_CHAT_MAX_TEXT_LEN
        )
        let thread = usableThreadName(target.thread, target.space)
        let lastName: string | undefined
        for (const chunk of chunks) {
            const res = await this.createMessage(ctx, sa, target.space, chunk, thread)
            lastName = res.name ?? lastName
            // Chunk 1 may have opened the thread; carry it so the rest of a
            // long reply stays together instead of scattering across the space.
            thread = thread ?? usableThreadName(res.thread?.name ?? null, target.space)
        }
        return { providerMessageId: lastName }
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<PreviewHandle> {
        const sa = this.requireServiceAccount(ctx)
        const target = googleChatTargetFromScopeKey(scopeKey)
        const thread = usableThreadName(target.thread, target.space)
        const res = await this.createMessage(
            ctx,
            sa,
            target.space,
            '⏳ thinking…',
            thread
        )
        if (!res.name) throw new Error('googlechat preview returned no message name')
        return {
            providerMessageId: res.name,
            // Keep the thread so the fallback and continuation chunks land in
            // the same place even when the in-place edit fails.
            raw: {
                space: target.space,
                thread: thread ?? usableThreadName(res.thread?.name ?? null, target.space)
            }
        }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        const sa = this.requireServiceAccount(ctx)
        const raw = handle.raw as { space?: string } | undefined
        if (!raw?.space) return
        const text = truncate(
            markdownToGoogleChat(partial),
            GOOGLE_CHAT_MAX_TEXT_LEN - 32
        )
        await this.patchMessage(
            ctx,
            sa,
            raw.space,
            handle.providerMessageId,
            `${text}\n\n_⏳ streaming…_`
        ).catch((err) => {
            this.logger.warn(
                `googlechat preview update failed: ${(err as Error).message}`
            )
        })
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        const sa = this.requireServiceAccount(ctx)
        const raw = handle.raw as
            | { space?: string; thread?: string | null }
            | undefined
        if (!raw?.space) return
        const space = raw.space
        const chunks = chunkText(
            markdownToGoogleChat(wrapMarkdownTables(finalText)),
            GOOGLE_CHAT_MAX_TEXT_LEN
        )
        const head = chunks[0] ?? '(empty)'
        let thread = usableThreadName(raw.thread ?? null, space)
        await this.patchMessage(
            ctx,
            sa,
            space,
            handle.providerMessageId,
            head
        ).catch(async (err) => {
            this.logger.warn(
                `googlechat preview finish failed, posting fresh: ${(err as Error).message}`
            )
            const res = await this.createMessage(ctx, sa, space, head, thread)
            thread = thread ?? usableThreadName(res.thread?.name ?? null, space)
        })
        for (let i = 1; i < chunks.length; i += 1) {
            const res = await this.createMessage(
                ctx,
                sa,
                space,
                chunks[i],
                thread
            )
            thread = thread ?? usableThreadName(res.thread?.name ?? null, space)
        }
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const sa = this.requireServiceAccount(ctx)
        if (!attachment.url.startsWith(MEDIA_PREFIX))
            throw new Error('googlechat attachment url is not a media url')
        const resourceName = attachment.url.slice(MEDIA_PREFIX.length)
        if (!resourceName)
            throw new Error('googlechat attachment resource name is empty')
        const token = await getGoogleChatAccessToken(ctx.channel.id, sa)
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            MEDIA_DOWNLOAD_TIMEOUT_MS
        )
        let response: Response
        try {
            response = await fetch(
                `${CHAT_API_BASE}/media/${encodeURI(resourceName)}?alt=media`,
                {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${token}` },
                    signal: controller.signal
                }
            )
        } finally {
            clearTimeout(timer)
        }
        if (!response.ok)
            throw new Error(
                `googlechat media download failed: http ${response.status}`
            )
        const contentType =
            response.headers?.get?.('content-type')?.split(';')[0]?.trim() ||
            attachment.contentType ||
            'application/octet-stream'
        const bytes = await readCappedBody(response, opts.maxBytes)
        return { name: attachment.name, contentType, bytes }
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials =
            ctx.credentials as GoogleChatChannelCredentials | null
        if (!credentials?.serviceAccountJson)
            return { ok: false, message: '✗ serviceAccountJson missing' }
        let sa: GoogleChatServiceAccount
        try {
            sa = parseGoogleChatServiceAccount(credentials.serviceAccountJson)
        } catch (err) {
            return {
                ok: false,
                message: `✗ service account key rejected: ${(err as Error).message}`
            }
        }
        const config = ctx.config as GoogleChatChannelConfig
        const lines: string[] = []
        let ok = true
        try {
            await this.callApi(ctx, sa, 'spaces.list', 'GET', '/spaces?pageSize=1')
            lines.push(`✓ authenticated as ${sa.clientEmail}`)
        } catch (err) {
            const message = (err as Error).message
            // An app that is not in any space yet still has working
            // credentials; that is a setup step, not a broken channel.
            if (message.includes('PERMISSION_DENIED'))
                lines.push(
                    `✓ authenticated as ${sa.clientEmail} (no spaces visible yet — add the app to a space)`
                )
            else return { ok: false, message: `✗ authentication failed: ${message}` }
        }
        if (!config.audience) {
            ok = false
            lines.push(
                config.audienceType === 'app-url'
                    ? '✗ audience not set — run Register to capture the inbound URL'
                    : '✗ audience not set — enter your Google Cloud project number'
            )
        } else lines.push(`✓ audience (${config.audienceType}): ${config.audience}`)
        if (ctx.channel.status === 'draft') {
            ok = false
            lines.push(
                '✗ channel is still draft — run Register to activate it, then paste the inbound URL into Google Cloud console → Chat API → Configuration → Connection settings → HTTP endpoint URL'
            )
        } else if (ctx.channel.status === 'error') {
            ok = false
            lines.push(
                `✗ channel status is error — ${ctx.channel.lastErrorMessage ?? 'unknown'}`
            )
        } else lines.push(`✓ channel status: ${ctx.channel.status}`)
        return { ok, message: lines.join('\n') }
    }

    private requireServiceAccount(
        ctx: ChannelContext
    ): GoogleChatServiceAccount {
        const credentials =
            ctx.credentials as GoogleChatChannelCredentials | null
        if (!credentials?.serviceAccountJson)
            throw new BadRequestException('googlechat serviceAccountJson missing')
        return parseGoogleChatServiceAccount(credentials.serviceAccountJson)
    }

    private async createMessage(
        ctx: ChannelContext,
        sa: GoogleChatServiceAccount,
        space: string,
        text: string,
        thread: string | null
    ): Promise<GoogleChatMessageResponse> {
        // Without messageReplyOption, Chat silently ignores thread.name and
        // drops the reply at the top level of the space.
        const query = thread
            ? '?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
            : ''
        return this.paceSpaceWrite(space, () =>
            this.callApi<GoogleChatMessageResponse>(
                ctx,
                sa,
                'messages.create',
                'POST',
                `/${space}/messages${query}`,
                { text, ...(thread ? { thread: { name: thread } } : {}) }
            )
        )
    }

    private async patchMessage(
        ctx: ChannelContext,
        sa: GoogleChatServiceAccount,
        space: string,
        messageName: string,
        text: string
    ): Promise<GoogleChatMessageResponse> {
        return this.paceSpaceWrite(space, () =>
            this.callApi<GoogleChatMessageResponse>(
                ctx,
                sa,
                'messages.patch',
                'PATCH',
                `/${messageName}?updateMask=text`,
                { text }
            )
        )
    }

    private async paceSpaceWrite<T>(
        space: string,
        fn: () => Promise<T>
    ): Promise<T> {
        if (this.spaceWriteChain.size > SPACE_CHAIN_MAX) {
            this.spaceWriteChain.clear()
            this.lastSpaceWriteAt.clear()
        }
        const prior = this.spaceWriteChain.get(space) ?? Promise.resolve()
        const run = prior.then(async () => {
            const wait =
                (this.lastSpaceWriteAt.get(space) ?? 0) +
                SPACE_WRITE_GAP_MS -
                Date.now()
            if (wait > 0)
                await new Promise<void>((resolve) => setTimeout(resolve, wait))
            this.lastSpaceWriteAt.set(space, Date.now())
            return fn()
        })
        // The chain must survive a failed write, or one error would wedge every
        // later send to that space.
        this.spaceWriteChain.set(
            space,
            run.then(
                () => undefined,
                () => undefined
            )
        )
        return run
    }

    private async callApi<T = Record<string, unknown>>(
        ctx: ChannelContext,
        sa: GoogleChatServiceAccount,
        operation: string,
        method: string,
        path: string,
        body?: unknown
    ): Promise<T> {
        const token = await getGoogleChatAccessToken(ctx.channel.id, sa)
        const res = await channelProviderJsonRequest<Record<string, unknown>>({
            provider: 'googlechat',
            operation,
            url: `${CHAT_API_BASE}${path}`,
            init: {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            }
        })
        if (res.ok) return (res.json ?? {}) as T
        // A stale token outlives a credential rotation; drop it so the next
        // attempt re-mints rather than repeating the same 401.
        if (res.status === 401) invalidateGoogleChatAccessToken(ctx.channel.id)
        const error = (res.json as { error?: { status?: string; message?: string } } | null)
            ?.error
        const rpcStatus = error?.status ?? null
        const detail = error?.message ?? res.text.slice(0, 300)
        const message = `googlechat ${operation} http ${res.status}${rpcStatus ? ` (${rpcStatus})` : ''}: ${detail}`
        const kind = classifyGoogleChatError(res.status, rpcStatus)
        if (kind === null) throw new Error(message)
        throw new ChannelSendError(kind, message, {
            retryAfterMs: kind === 'rate_limited' ? res.retryAfterMs : null
        })
    }
}

const parseAudienceType = (value: unknown): GoogleChatAudienceType =>
    value === 'project-number' ? 'project-number' : 'app-url'

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
    for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v
    return out
}

// 'spaces/AAA' -> 'AAA', 'spaces/AAA/threads/BBB' -> 'BBB'.
const resourceSuffix = (name: string): string | null => {
    const parts = name.split('/')
    const last = parts[parts.length - 1]
    return last && last.length > 0 ? last : null
}

const isDirectMessage = (space: GoogleChatSpacePayload): boolean => {
    if (space.singleUserBotDm === true) return true
    const kind = space.spaceType ?? space.type
    return kind === 'DIRECT_MESSAGE' || kind === 'DM'
}

const normalizeAttachments = (
    attachments: GoogleChatAttachmentPayload[] | undefined
): NormalizedInboundAttachment[] => {
    if (!Array.isArray(attachments)) return []
    const out: NormalizedInboundAttachment[] = []
    for (const attachment of attachments) {
        // Drive-hosted files have no downloadable media ref: reading them needs
        // a user-authorized Drive scope this app does not hold.
        const resourceName = attachment.attachmentDataRef?.resourceName
        if (typeof resourceName !== 'string' || resourceName.length === 0)
            continue
        out.push({
            url: `${MEDIA_PREFIX}${resourceName}`,
            name: attachment.contentName ?? attachment.name ?? 'file',
            contentType: attachment.contentType ?? null,
            size: null
        })
    }
    return out
}

const normalizeActorId = (value: string): string => value.trim().toLowerCase()

// Everything this sender could be listed as in an allowlist: the bare id, the
// users/{id} resource name, and the email (which only the raw payload carries).
const actorIdentities = (event: NormalizedInboundEvent): Set<string> => {
    const out = new Set<string>([
        normalizeActorId(event.senderId),
        normalizeActorId(`users/${event.senderId}`)
    ])
    const raw = event.raw as GoogleChatEventBody | undefined
    const email = raw?.message?.sender?.email ?? raw?.user?.email
    if (typeof email === 'string' && email.trim().length > 0)
        out.add(normalizeActorId(email))
    return out
}

// googlechat:{dm|space}:{spaceId}[:{userId}][:thread:{threadId}]
export const googleChatTargetFromScopeKey = (
    scopeKey: string
): { space: string; thread: string | null } => {
    const segments = scopeKey.split(':')
    const spaceId = segments[2]
    if (segments[0] !== 'googlechat' || !spaceId)
        throw new Error(`invalid scopeKey ${scopeKey}`)
    const space = `spaces/${spaceId}`
    // The thread marker sits at a different index for a shared space scope than
    // for a per-user one, so find it rather than assume a position. Chat ids
    // never equal the literal 'thread'.
    const marker = segments.indexOf('thread', 3)
    if (marker !== -1 && segments[marker + 1])
        return { space, thread: `${space}/threads/${segments[marker + 1]}` }
    return { space, thread: null }
}

// A thread from another space, or a malformed one, is a 400 INVALID_ARGUMENT —
// which dead-letters the delivery. Dropping it costs the threading but still
// delivers the reply.
const usableThreadName = (
    thread: string | null,
    space: string
): string | null => {
    if (!thread) return null
    if (!/^spaces\/[^/]+\/threads\/[^/]+$/.test(thread)) return null
    return thread.startsWith(`${space}/threads/`) ? thread : null
}

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.length > maxBytes)
            throw new Error(`googlechat media exceeds ${maxBytes} bytes`)
        return buf
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
            throw new Error(`googlechat media exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}

const truncate = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`
