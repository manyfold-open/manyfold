import type {
    ChannelTestResult,
    MsTeamsChannelConfig,
    MsTeamsChannelCredentials
} from '@manyfold/shared'
import { MSTEAMS_DEFAULT_SERVICE_URL } from '@manyfold/shared'
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
import {
    markdownToMsTeams,
    stripMsTeamsMentions,
    type MsTeamsMentionSpan
} from './msteams-format'
import {
    getMsTeamsAccessToken,
    invalidateMsTeamsAccessToken,
    isMsTeamsConnectorHost,
    normalizeMsTeamsServiceUrl,
    verifyMsTeamsToken
} from './msteams-auth'

// Teams truncates a message at 28 000 characters; Hermes uses the same budget.
const MSTEAMS_MAX_TEXT_LEN = 28_000
// A typing activity decays after roughly ten seconds, so it has to be re-fired
// while a turn runs. The cap stops a wedged turn from typing forever.
const TYPING_REFRESH_MS = 8_000
const TYPING_MAX_MS = 10 * 60_000
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000
// Teams marks a channel thread by suffixing the conversation id rather than
// giving it a field of its own.
const THREAD_SUFFIX = ';messageid='

const HTTP_ERROR_KINDS: Record<number, ChannelSendErrorKind> = {
    400: 'bad_format',
    403: 'forbidden',
    404: 'not_found',
    413: 'too_long',
    429: 'rate_limited',
    502: 'transient',
    503: 'transient',
    504: 'transient'
}

// 401 is deliberately absent: it is usually a token minted before a credential
// rotation, and 'forbidden' would dead-letter the delivery instead of letting a
// re-mint deliver it.
export const classifyMsTeamsError = (
    status: number
): ChannelSendErrorKind | null => HTTP_ERROR_KINDS[status] ?? null

interface MsTeamsAccount {
    id?: string
    name?: string
    aadObjectId?: string
}

interface MsTeamsConversationAccount {
    id?: string
    conversationType?: string
    tenantId?: string
    isGroup?: boolean
    name?: string
}

interface MsTeamsMentionEntity {
    type?: string
    text?: string
    mentioned?: MsTeamsAccount
}

interface MsTeamsAttachmentPayload {
    contentType?: string
    contentUrl?: string
    name?: string
    content?: {
        downloadUrl?: string
        uniqueId?: string
        fileType?: string
    }
}

interface MsTeamsActivity {
    type?: string
    id?: string
    timestamp?: string
    serviceUrl?: string
    text?: string
    textFormat?: string
    replyToId?: string
    from?: MsTeamsAccount
    recipient?: MsTeamsAccount
    conversation?: MsTeamsConversationAccount
    entities?: MsTeamsMentionEntity[]
    attachments?: MsTeamsAttachmentPayload[]
    channelData?: {
        tenant?: { id?: string }
        team?: { id?: string; name?: string }
        channel?: { id?: string; name?: string }
    }
}

interface MsTeamsResourceResponse {
    id?: string
}

@Injectable()
export class MsTeamsChannelProvider implements ChannelProvider {
    readonly name = 'msteams' as const
    // Teams publishes no per-conversation edit budget, but the Bot Connector
    // throttles a chatty bot per app. Two seconds keeps a streaming preview
    // well inside that without making the reply feel stalled.
    readonly previewUpdateMinIntervalMs = 2000
    private readonly logger = new Logger(MsTeamsChannelProvider.name)

    validateConfig(config: unknown): MsTeamsChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botId: optionalString(c.botId),
            botName: optionalString(c.botName),
            serviceUrl: parseServiceUrl(c.serviceUrl),
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            allowedConversationIds: stringList(c.allowedConversationIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            threadIsolation: c.threadIsolation !== false,
            progressMode: parseProgressMode(c.progressMode),
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(
        credentials: unknown
    ): MsTeamsChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const appId = requiredString(c.appId, 'credentials.appId is required')
        const appPassword = requiredString(
            c.appPassword,
            'credentials.appPassword is required'
        )
        const tenantId = requiredString(
            c.tenantId,
            'credentials.tenantId is required'
        )
        return { appId, appPassword, tenantId }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult> {
        const credentials = ctx.credentials as MsTeamsChannelCredentials | null
        if (!credentials)
            return { ok: false, message: 'appId, appPassword and tenantId are required' }
        const config = ctx.config as MsTeamsChannelConfig
        try {
            await getMsTeamsAccessToken(ctx.channel.id, credentials)
        } catch (err) {
            // A bad secret, a wrong tenant and a deleted app registration all
            // land here, and all of them mean nothing will ever arrive.
            invalidateMsTeamsAccessToken(ctx.channel.id)
            return {
                ok: false,
                message: `Azure Bot credentials rejected: ${(err as Error).message}`
            }
        }
        const configPatch: MsTeamsChannelConfig = {
            ...config,
            // The app id is also the bot's id inside an activity, so capturing
            // it here is what lets parseInbound resolve a self-mention and drop
            // the bot's own echo without a second round trip.
            botId: credentials.appId,
            serviceUrl: config.serviceUrl ?? MSTEAMS_DEFAULT_SERVICE_URL
        }
        return {
            ok: true,
            // Teams has no verification handshake to flip the channel live, so
            // register() activates it once the credentials are proven — the
            // same contract Linear, GitHub and Google Chat use.
            activate: true,
            message: `Azure Bot ${credentials.appId} authenticated. Set the bot's messaging endpoint to ${inboundUrl}, then upload the Teams app manifest and install it.`,
            configPatch
        }
    }

    async verifySignature(
        req: InboundRequest,
        ctx: ChannelContext
    ): Promise<SignatureCheck> {
        const credentials = ctx.credentials as MsTeamsChannelCredentials | null
        if (!credentials?.appId) return { ok: false, reason: 'app_id_missing' }
        const headers = lowercaseHeaders(req.headers)
        const authorization = headers['authorization'] ?? ''
        const token = authorization.toLowerCase().startsWith('bearer ')
            ? authorization.slice(7).trim()
            : ''
        if (!token) return { ok: false, reason: 'missing_bearer_token' }
        const activity = (req.body ?? {}) as MsTeamsActivity
        const check = await verifyMsTeamsToken({
            token,
            appId: credentials.appId,
            serviceUrl: activity.serviceUrl ?? null
        })
        if (!check.ok)
            return { ok: false, reason: check.reason ?? 'token_invalid' }
        // The token proves the Bot Connector sent this, not which tenant it
        // came from — a multi-tenant bot registration would accept activities
        // from any tenant that installed it. This channel is bound to one.
        const tenant = activity.channelData?.tenant?.id
        if (
            typeof tenant === 'string' &&
            tenant.length > 0 &&
            tenant.toLowerCase() !== credentials.tenantId.toLowerCase()
        )
            return { ok: false, reason: 'tenant_mismatch' }
        // Teams has no url_verification ping, so there is never a challenge to
        // answer; the channel is activated by register() instead.
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const config = ctx.config as MsTeamsChannelConfig
        const activity = (req.body ?? {}) as MsTeamsActivity
        const type = activity.type
        if (!type) throw new UnsupportedEventError('unknown')
        if (type !== 'message') throw new UnsupportedEventError(type)
        const activityId = activity.id
        if (!activityId) throw new BadRequestException('missing activity id')
        const rawConversationId = activity.conversation?.id
        if (!rawConversationId)
            throw new BadRequestException('missing conversation id')
        const senderId =
            activity.from?.aadObjectId ?? activity.from?.id ?? null
        if (!senderId) throw new BadRequestException('missing sender')
        // Teams echoes a bot's own posts into channel history; recipient is the
        // bot, and from === recipient means we are reading ourselves.
        if (config.botId && activity.from?.id === config.botId)
            throw new UnsupportedEventError('self_message')

        const { conversationId, threadId } =
            splitConversationId(rawConversationId)
        const conversationType = activity.conversation?.conversationType
        const chatType: 'private' | 'group' =
            conversationType === 'personal' ? 'private' : 'group'

        // Match on the entity's id, never on the <at> display name: the name is
        // whatever the sender typed and a group member can spoof it, while
        // mentioned.id is resolved by Teams itself.
        const botId = config.botId ?? activity.recipient?.id ?? null
        const mentions = mentionSpans(activity.entities)
        const isMention =
            chatType === 'private' ||
            (botId !== null &&
                mentions.some((mention) => mention.id === botId))

        const attachments = normalizeAttachments(activity.attachments)
        const text = stripMsTeamsMentions(activity.text ?? '', mentions, botId)
        if (text.length === 0 && attachments.length === 0)
            throw new UnsupportedEventError('empty_text')

        return {
            providerEventId: `msteams-${activityId}`,
            chatId: conversationId,
            chatType,
            senderId,
            senderName: activity.from?.name ?? null,
            text,
            ...(attachments.length > 0 ? { attachments } : {}),
            threadId,
            isMention,
            messageId: activityId,
            replyToMessageId: activity.replyToId ?? null,
            // Teams threads a reply by conversation id, not by referencing a
            // message, so there is nothing to answer "as a reply to" — and in a
            // personal chat a quote of the only other participant is noise.
            replyTargetId: null,
            raw: activity
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: MsTeamsChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        // Teams conversation ids embed colons ('19:…@thread.tacv2', 'a:1kZ…'),
        // which are this key's separator, so they are percent-encoded.
        const encoded = encodeURIComponent(event.chatId)
        const scopeName = conversationLabel(event)
        if (event.chatType === 'private')
            return {
                scopeKey: `msteams:dm:${encoded}:${event.senderId}`,
                scopeName
            }
        const base = `msteams:conv:${encoded}`
        if (event.threadId && config.threadIsolation)
            return {
                scopeKey: `${base}:thread:${event.threadId}`,
                scopeName
            }
        if (config.shareSessionInChannel) return { scopeKey: base, scopeName }
        return { scopeKey: `${base}:${event.senderId}`, scopeName }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: MsTeamsChannelConfig
    ): InboundActorPolicy {
        const raw = event.raw as MsTeamsActivity | undefined
        const allowedConversations = config.allowedConversationIds ?? []
        if (
            allowedConversations.length > 0 &&
            !allowedConversations.some(
                (id) => splitConversationId(id).conversationId === event.chatId
            )
        )
            return {
                allowed: false,
                reason: 'conversation_not_allowed',
                operator: false
            }
        // Entra object ids are the stable identifier and what the setup docs
        // ask for. A UPN or a display name is never matched, because either can
        // be reassigned to a different person. An activity without an
        // aadObjectId falls back to the '29:…' Teams user id, which is
        // per-app — an object-id allowlist simply will not match it, so such a
        // sender is rejected rather than let through.
        const identities = new Set<string>([normalizeActorId(event.senderId)])
        const aad = raw?.from?.aadObjectId
        if (typeof aad === 'string' && aad.length > 0)
            identities.add(normalizeActorId(aad))
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
        const target = msTeamsTargetFromScopeKey(scopeKey)
        return this.postChunks(ctx, target, text)
    }

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        if (target.kind === 'user')
            // Reaching a person who has never messaged the bot means creating a
            // conversation, which only works once the app is installed for that
            // user — a precondition Manyfold cannot see or report on.
            throw new BadRequestException(
                'msteams agent send requires a conversation id, not a user id'
            )
        if (target.kind === 'reply')
            throw new BadRequestException(
                'msteams agent send cannot target a single message'
            )
        return this.postChunks(
            ctx,
            splitConversationId(target.chatId),
            text
        )
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<() => void> {
        const target = msTeamsTargetFromScopeKey(scopeKey)
        let stopped = false
        const fire = (): void => {
            if (stopped) return
            void this.callApi(
                ctx,
                'conversations.typing',
                'POST',
                `v3/conversations/${encodeURIComponent(conversationPath(target))}/activities`,
                { type: 'typing' }
            ).catch(() => undefined)
        }
        fire()
        const interval = setInterval(fire, TYPING_REFRESH_MS)
        const cap = setTimeout(() => {
            stopped = true
            clearInterval(interval)
        }, TYPING_MAX_MS)
        interval.unref?.()
        cap.unref?.()
        return () => {
            stopped = true
            clearInterval(interval)
            clearTimeout(cap)
        }
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<PreviewHandle> {
        const target = msTeamsTargetFromScopeKey(scopeKey)
        const res = await this.createActivity(ctx, target, '⏳ thinking…')
        if (!res.id) throw new Error('msteams preview returned no activity id')
        return { providerMessageId: res.id, raw: target }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        const target = handle.raw as MsTeamsTarget | undefined
        if (!target?.conversationId) return
        const text = truncate(
            markdownToMsTeams(partial),
            MSTEAMS_MAX_TEXT_LEN - 32
        )
        await this.updateActivity(
            ctx,
            target,
            handle.providerMessageId,
            `${text}\n\n_⏳ streaming…_`
        ).catch((err) => {
            this.logger.warn(
                `msteams preview update failed: ${(err as Error).message}`
            )
        })
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        const target = handle.raw as MsTeamsTarget | undefined
        if (!target?.conversationId) return
        const chunks = chunkText(
            markdownToMsTeams(wrapMarkdownTables(finalText)),
            MSTEAMS_MAX_TEXT_LEN
        )
        const head = chunks[0] ?? '(empty)'
        await this.updateActivity(
            ctx,
            target,
            handle.providerMessageId,
            head
        ).catch(async (err) => {
            this.logger.warn(
                `msteams preview finish failed, posting fresh: ${(err as Error).message}`
            )
            await this.createActivity(ctx, target, head)
        })
        for (let i = 1; i < chunks.length; i += 1)
            await this.createActivity(ctx, target, chunks[i])
    }

    async deleteMessage(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string
    ): Promise<void> {
        const target = msTeamsTargetFromScopeKey(scopeKey)
        await this.callApi(
            ctx,
            'conversations.deleteActivity',
            'DELETE',
            `v3/conversations/${encodeURIComponent(conversationPath(target))}/activities/${encodeURIComponent(providerMessageId)}`
        )
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const url = new URL(attachment.url)
        if (url.protocol !== 'https:')
            throw new Error('msteams attachment url is not https')
        // An inline image lives on the Bot Connector and needs — and may see —
        // the bot token. A file-consent download url is already pre-authorized
        // and points at SharePoint; sending the token there would leak it.
        const headers: Record<string, string> = {}
        if (isMsTeamsConnectorHost(url.hostname))
            headers.Authorization = `Bearer ${await this.token(ctx)}`
        else if (!isTrustedAttachmentHost(url.hostname))
            throw new Error(
                `msteams attachment host not allowed: ${url.hostname}`
            )
        const controller = new AbortController()
        const timer = setTimeout(
            () => controller.abort(),
            MEDIA_DOWNLOAD_TIMEOUT_MS
        )
        let response: Response
        try {
            response = await fetch(attachment.url, {
                method: 'GET',
                headers,
                signal: controller.signal
            })
        } finally {
            clearTimeout(timer)
        }
        if (!response.ok)
            throw new Error(
                `msteams attachment download failed: http ${response.status}`
            )
        const contentType =
            response.headers?.get?.('content-type')?.split(';')[0]?.trim() ||
            attachment.contentType ||
            'application/octet-stream'
        const bytes = await readCappedBody(response, opts.maxBytes)
        return { name: attachment.name, contentType, bytes }
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as MsTeamsChannelCredentials | null
        if (!credentials?.appId)
            return { ok: false, message: '✗ Azure Bot credentials missing' }
        const config = ctx.config as MsTeamsChannelConfig
        const lines: string[] = []
        let ok = true
        try {
            await getMsTeamsAccessToken(ctx.channel.id, credentials)
            lines.push(`✓ authenticated as app ${credentials.appId}`)
        } catch (err) {
            invalidateMsTeamsAccessToken(ctx.channel.id)
            return {
                ok: false,
                message: `✗ authentication failed: ${(err as Error).message}`
            }
        }
        const serviceUrl = config.serviceUrl ?? MSTEAMS_DEFAULT_SERVICE_URL
        if (normalizeMsTeamsServiceUrl(serviceUrl)) {
            lines.push(`✓ Bot Connector endpoint: ${serviceUrl}`)
        } else {
            ok = false
            lines.push(`✗ Bot Connector endpoint not recognized: ${serviceUrl}`)
        }
        if (ctx.channel.status === 'draft') {
            ok = false
            lines.push(
                '✗ channel is still draft — run Register to activate it, then set the bot messaging endpoint in the Azure portal to this channel’s inbound URL'
            )
        } else if (ctx.channel.status === 'error') {
            ok = false
            lines.push(
                `✗ channel status is error — ${ctx.channel.lastErrorMessage ?? 'unknown'}`
            )
        } else lines.push(`✓ channel status: ${ctx.channel.status}`)
        // Nothing here proves Teams can reach us: the Bot Connector never calls
        // back on demand. Say so rather than implying a green test means live.
        lines.push(
            'ℹ send the bot a direct message in Teams to confirm delivery end to end'
        )
        return { ok, message: lines.join('\n') }
    }

    private async postChunks(
        ctx: ChannelContext,
        target: MsTeamsTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        const chunks = chunkText(
            markdownToMsTeams(wrapMarkdownTables(text)),
            MSTEAMS_MAX_TEXT_LEN
        )
        let lastId: string | undefined
        for (const chunk of chunks) {
            const res = await this.createActivity(ctx, target, chunk)
            lastId = res.id ?? lastId
        }
        return { providerMessageId: lastId }
    }

    private async createActivity(
        ctx: ChannelContext,
        target: MsTeamsTarget,
        text: string
    ): Promise<MsTeamsResourceResponse> {
        return this.callApi<MsTeamsResourceResponse>(
            ctx,
            'conversations.createActivity',
            'POST',
            `v3/conversations/${encodeURIComponent(conversationPath(target))}/activities`,
            { type: 'message', textFormat: 'markdown', text }
        )
    }

    private async updateActivity(
        ctx: ChannelContext,
        target: MsTeamsTarget,
        activityId: string,
        text: string
    ): Promise<MsTeamsResourceResponse> {
        return this.callApi<MsTeamsResourceResponse>(
            ctx,
            'conversations.updateActivity',
            'PUT',
            `v3/conversations/${encodeURIComponent(conversationPath(target))}/activities/${encodeURIComponent(activityId)}`,
            { type: 'message', textFormat: 'markdown', text }
        )
    }

    private async token(ctx: ChannelContext): Promise<string> {
        const credentials = ctx.credentials as MsTeamsChannelCredentials | null
        if (!credentials?.appId)
            throw new BadRequestException('msteams credentials missing')
        return getMsTeamsAccessToken(ctx.channel.id, credentials)
    }

    private async callApi<T = Record<string, unknown>>(
        ctx: ChannelContext,
        operation: string,
        method: string,
        path: string,
        body?: unknown
    ): Promise<T> {
        const config = ctx.config as MsTeamsChannelConfig
        const base = normalizeMsTeamsServiceUrl(
            config.serviceUrl ?? MSTEAMS_DEFAULT_SERVICE_URL
        )
        if (!base)
            throw new ChannelSendError(
                'bad_format',
                `msteams serviceUrl is not a Bot Connector endpoint: ${config.serviceUrl}`
            )
        const token = await this.token(ctx)
        const res = await channelProviderJsonRequest<Record<string, unknown>>({
            provider: 'msteams',
            operation,
            url: `${base}${path}`,
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
        if (res.status === 401) invalidateMsTeamsAccessToken(ctx.channel.id)
        const error = (
            res.json as { error?: { code?: string; message?: string } } | null
        )?.error
        const detail = error?.message ?? res.text.slice(0, 300)
        const message = `msteams ${operation} http ${res.status}${error?.code ? ` (${error.code})` : ''}: ${detail}`
        const kind = classifyMsTeamsError(res.status)
        if (kind === null) throw new Error(message)
        throw new ChannelSendError(kind, message, {
            retryAfterMs: kind === 'rate_limited' ? res.retryAfterMs : null
        })
    }
}

interface MsTeamsTarget {
    conversationId: string
    threadId: string | null
}

const optionalString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const requiredString = (value: unknown, message: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0)
        throw new BadRequestException(message)
    return value.trim()
}

const parseServiceUrl = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.trim().length === 0) return null
    const normalized = normalizeMsTeamsServiceUrl(value)
    if (!normalized)
        throw new BadRequestException(
            `config.serviceUrl is not a Bot Connector endpoint: ${value.trim()}`
        )
    return normalized
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

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v
    return out
}

// '19:abc@thread.tacv2;messageid=1700000000000' -> the channel conversation
// plus the thread root it addresses. Teams has no separate thread field: the
// suffix IS the thread, and posting back needs the whole id reassembled.
export const splitConversationId = (
    raw: string
): { conversationId: string; threadId: string | null } => {
    const index = raw.indexOf(THREAD_SUFFIX)
    if (index === -1) return { conversationId: raw, threadId: null }
    const threadId = raw.slice(index + THREAD_SUFFIX.length)
    return {
        conversationId: raw.slice(0, index),
        threadId: threadId.length > 0 ? threadId : null
    }
}

const conversationPath = (target: MsTeamsTarget): string =>
    target.threadId
        ? `${target.conversationId}${THREAD_SUFFIX}${target.threadId}`
        : target.conversationId

// msteams:{dm|conv}:{encodedConversationId}[:{userId}][:thread:{threadId}]
export const msTeamsTargetFromScopeKey = (
    scopeKey: string
): MsTeamsTarget => {
    const segments = scopeKey.split(':')
    const encoded = segments[2]
    if (segments[0] !== 'msteams' || !encoded)
        throw new Error(`invalid scopeKey ${scopeKey}`)
    let conversationId: string
    try {
        conversationId = decodeURIComponent(encoded)
    } catch {
        throw new Error(`invalid scopeKey ${scopeKey}`)
    }
    // The thread marker sits at a different index for a shared conversation
    // scope than for a per-user one, so find it rather than assume a position.
    const marker = segments.indexOf('thread', 3)
    const threadId =
        marker !== -1 && segments[marker + 1] ? segments[marker + 1] : null
    return { conversationId, threadId }
}

const conversationLabel = (event: NormalizedInboundEvent): string | null => {
    const raw = event.raw as MsTeamsActivity | undefined
    const channelName = raw?.channelData?.channel?.name
    const teamName = raw?.channelData?.team?.name
    if (channelName && teamName) return `${teamName} / ${channelName}`
    return channelName ?? teamName ?? raw?.conversation?.name ?? null
}

// Teams file attachments come in two shapes. A file-consent card carries a
// pre-authorized SharePoint downloadUrl; an inline image is a connector-hosted
// contentUrl that needs the bot token. In a channel or group chat Teams strips
// the reference entirely and sends an HTML stub instead — recovering those
// needs Microsoft Graph application permissions and tenant admin consent, which
// this provider deliberately does not require.
const normalizeAttachments = (
    attachments: MsTeamsAttachmentPayload[] | undefined
): NormalizedInboundAttachment[] => {
    if (!Array.isArray(attachments)) return []
    const out: NormalizedInboundAttachment[] = []
    for (const attachment of attachments) {
        const contentType = attachment.contentType ?? ''
        if (contentType === 'text/html') continue
        const url = attachment.content?.downloadUrl ?? attachment.contentUrl
        if (typeof url !== 'string' || !url.startsWith('https://')) continue
        out.push({
            url,
            name: attachment.name ?? 'file',
            contentType:
                contentType ===
                'application/vnd.microsoft.teams.file.download.info'
                    ? (attachment.content?.fileType ?? null)
                    : (attachment.contentType ?? null),
            size: null
        })
    }
    return out
}

// Where a pre-authorized Teams download url may point. The token is never sent
// to these, but an unbounded host would still make the API a fetch proxy.
const TRUSTED_ATTACHMENT_HOST_SUFFIXES = [
    '.sharepoint.com',
    '.sharepoint-df.com',
    '.svc.ms',
    '.office.com',
    '.microsoft.com',
    '.windows.net'
]

const isTrustedAttachmentHost = (hostname: string): boolean =>
    TRUSTED_ATTACHMENT_HOST_SUFFIXES.some((suffix) =>
        hostname.endsWith(suffix)
    )

// entities[] is how Teams reports who was really mentioned. mentioned.id is the
// bot's app id for a self-mention and the Teams user id otherwise; aadObjectId
// is present for a person and absent for the bot.
const mentionSpans = (
    entities: MsTeamsMentionEntity[] | undefined
): MsTeamsMentionSpan[] =>
    (entities ?? [])
        .filter((entity) => entity.type === 'mention')
        .map((entity) => ({
            text: entity.text ?? '',
            id: entity.mentioned?.id ?? entity.mentioned?.aadObjectId ?? null,
            name: entity.mentioned?.name ?? null
        }))

const normalizeActorId = (value: string): string => value.trim().toLowerCase()

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.length > maxBytes)
            throw new Error(`msteams attachment exceeds ${maxBytes} bytes`)
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
            throw new Error(`msteams attachment exceeds ${maxBytes} bytes`)
        }
        chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
}

const truncate = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max - 1)}…`

// The Teams app package manifest for this channel's bot. Teams has no
// programmatic app-registration flow — the operator uploads a zip containing
// this file plus two icons — so Manyfold generates it rather than making them
// hand-write JSON and get the RSC block subtly wrong.
//
// The RSC permissions are what let the bot read channel and group-chat
// messages without being @-mentioned every time. They are scoped to the team
// or chat the app is installed in, and need no tenant admin consent.
export const buildMsTeamsAppManifest = (opts: {
    name: string
    appId: string
    inboundUrl: string
}): Record<string, unknown> => {
    const shortName = opts.name.trim().slice(0, 30) || 'Manyfold Agent'
    // validDomains gates which hosts the client will open in a task module. The
    // API host is the only one this bot ever links to.
    const inboundHost = safeHost(opts.inboundUrl)
    return {
        $schema:
            'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
        manifestVersion: '1.17',
        version: '1.0.0',
        // Teams requires the package id to be a GUID and permits reusing the
        // bot's app id, which keeps the operator from inventing a second one.
        id: opts.appId,
        developer: {
            name: 'Manyfold',
            websiteUrl: 'https://manyfold.ai',
            privacyUrl: 'https://manyfold.ai/privacy',
            termsOfUseUrl: 'https://manyfold.ai/terms'
        },
        name: { short: shortName, full: shortName },
        description: {
            short: 'Manyfold agent in Teams',
            full: `Chat with the Manyfold agent "${shortName}" in Teams.`
        },
        icons: { outline: 'outline.png', color: 'color.png' },
        accentColor: '#5B6DEF',
        bots: [
            {
                botId: opts.appId,
                scopes: ['personal', 'team', 'groupChat'],
                supportsFiles: true,
                isNotificationOnly: false
            }
        ],
        permissions: ['identity', 'messageTeamMembers'],
        ...(inboundHost ? { validDomains: [inboundHost] } : {}),
        authorization: {
            permissions: {
                resourceSpecific: [
                    // Channel (team) scope.
                    { name: 'ChannelMessage.Read.Group', type: 'Application' },
                    { name: 'ChannelMessage.Send.Group', type: 'Application' },
                    { name: 'TeamMember.Read.Group', type: 'Application' },
                    { name: 'ChannelSettings.Read.Group', type: 'Application' },
                    // Group-chat scope.
                    { name: 'ChatMessage.Read.Chat', type: 'Application' }
                ]
            }
        }
    }
}

const safeHost = (url: string): string | null => {
    try {
        return new URL(url).host
    } catch {
        return null
    }
}
