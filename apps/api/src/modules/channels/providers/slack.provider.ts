import type {
    ChannelTestResult,
    SlackChannelConfig,
    SlackChannelCredentials
} from '@manyfold/shared'
import { createHmac, timingSafeEqual } from 'node:crypto'
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
    type OutboundAttachment,
    type PreviewHandle,
    type RegistrationResult,
    type SendTextOptions,
    type SignatureCheck
} from '../channel-provider'
import { channelProviderJsonRequest } from './channel-http'
import {
    ChannelSendError,
    type ChannelSendErrorKind
} from '../channel-send-error'
import { parseProgressMode, parseResetOnIdleMins } from '../config-helpers'
import { chunkText } from '../text-chunk'
import { SLASH_COMMAND_SPECS } from '../slash/commands'

// Positive identification only — unknown codes keep the generic Error and
// today's ladder-retry path.
const SLACK_ERROR_KINDS: Record<string, ChannelSendErrorKind> = {
    ratelimited: 'rate_limited',
    channel_not_found: 'not_found',
    thread_not_found: 'not_found',
    message_not_found: 'not_found',
    is_archived: 'not_found',
    not_in_channel: 'forbidden',
    account_inactive: 'forbidden',
    invalid_auth: 'forbidden',
    token_revoked: 'forbidden',
    token_expired: 'forbidden',
    missing_scope: 'forbidden',
    restricted_action: 'forbidden',
    msg_too_long: 'too_long'
}

const classifySlackError = (code: string): ChannelSendErrorKind | null =>
    SLACK_ERROR_KINDS[code] ?? null

const SLACK_ACK_REACTIONS = {
    working: 'eyes',
    done: 'white_check_mark',
    failed: 'x'
} as const

const SLACK_API_BASE = 'https://slack.com/api'
const SLACK_MAX_TEXT_LEN = 3800
const SLACK_SIGNATURE_TOLERANCE_S = 5 * 60
// A slash command's response_url stays valid ~30 min for up to 5 posts; we
// keep the pending handle only long enough to cover the async dispatch gap.
const SLACK_RESPONSE_URL_TTL_MS = 5 * 60 * 1000
const SLACK_RESPONSE_URL_MAX_CHUNKS = 5
const SLACK_DOWNLOAD_TIMEOUT_MS = 15_000
const SLACK_DOWNLOAD_MAX_REDIRECTS = 3

interface SlackEventOuter {
    type?: string
    challenge?: string
    team_id?: string
    event_id?: string
    event?: SlackInnerEvent
}

interface SlackInboundFile {
    id?: string
    name?: string
    title?: string
    mimetype?: string
    size?: number
    url_private?: string
    url_private_download?: string
    mode?: string
}

interface SlackInnerEvent {
    type?: string
    subtype?: string
    bot_id?: string
    user?: string
    channel?: string
    channel_type?: string
    text?: string
    ts?: string
    thread_ts?: string
    team?: string
    files?: SlackInboundFile[]
}

@Injectable()
export class SlackChannelProvider implements ChannelProvider {
    readonly name = 'slack' as const
    // chat.update is Tier 3 (~50/min); stay well inside it while streaming.
    readonly previewUpdateMinIntervalMs = 1500
    private readonly logger = new Logger(SlackChannelProvider.name)
    // Slash-command reply routing: a native slash invocation carries a
    // single-use response_url that we drain from sendText via its interaction
    // ref (the synthetic providerEventId). Kept in memory only — never
    // persisted, so it cannot leak into event_json.
    private readonly pendingSlashResponses = new Map<
        string,
        { responseUrl: string; expiresAt: number }
    >()

    validateConfig(config: unknown): SlackChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            botUserId:
                typeof c.botUserId === 'string' && c.botUserId.trim().length > 0
                    ? c.botUserId.trim()
                    : null,
            teamId:
                typeof c.teamId === 'string' && c.teamId.trim().length > 0
                    ? c.teamId.trim()
                    : null,
            allowedUserIds: stringList(c.allowedUserIds),
            operatorUserIds: stringList(c.operatorUserIds),
            mentionOnly: c.mentionOnly !== false,
            shareSessionInChannel: c.shareSessionInChannel === true,
            threadIsolation: c.threadIsolation !== false,
            autoThread: c.autoThread === true,
            progressMode: parseProgressMode(c.progressMode),
            outboundFiles: c.outboundFiles !== false,
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(credentials: unknown): SlackChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const botToken = c.botToken
        const signingSecret = c.signingSecret
        if (
            typeof botToken !== 'string' ||
            !botToken.trim().startsWith('xoxb-')
        )
            throw new BadRequestException(
                'credentials.botToken must start with xoxb-'
            )
        if (
            typeof signingSecret !== 'string' ||
            signingSecret.trim().length < 16
        )
            throw new BadRequestException(
                'credentials.signingSecret is required'
            )
        return {
            botToken: botToken.trim(),
            signingSecret: signingSecret.trim()
        }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    async register(ctx: ChannelContext): Promise<RegistrationResult> {
        const credentials = ctx.credentials as SlackChannelCredentials | null
        if (!credentials?.botToken)
            return { ok: false, message: 'botToken missing' }
        try {
            const auth = await this.callApi<SlackAuthTest>(
                credentials.botToken,
                'auth.test',
                {}
            )
            const config = ctx.config as SlackChannelConfig
            const configPatch: SlackChannelConfig = {
                ...config,
                botUserId: auth.user_id ?? config.botUserId ?? null,
                teamId: auth.team_id ?? config.teamId ?? null
            }
            return {
                ok: true,
                message: `auth.test passed for ${auth.team ?? 'team'} as ${auth.user ?? 'bot'}`,
                configPatch
            }
        } catch (err) {
            return { ok: false, message: (err as Error).message }
        }
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const body = (req.body ?? {}) as SlackEventOuter
        const credentials = ctx.credentials as SlackChannelCredentials | null
        const signingSecret = credentials?.signingSecret
        if (!signingSecret)
            return { ok: false, reason: 'signing_secret_missing' }
        const headers = lowercaseHeaders(req.headers)
        const ts = headers['x-slack-request-timestamp']
        const sig = headers['x-slack-signature']
        if (!ts || !sig)
            return { ok: false, reason: 'missing_signature_headers' }
        const tsNum = Number(ts)
        if (!Number.isFinite(tsNum))
            return { ok: false, reason: 'bad_timestamp' }
        const ageSec = Math.abs(Date.now() / 1000 - tsNum)
        if (ageSec > SLACK_SIGNATURE_TOLERANCE_S)
            return { ok: false, reason: 'timestamp_out_of_range' }
        const rawBody =
            req.rawBody ??
            (typeof req.body === 'string'
                ? req.body
                : JSON.stringify(req.body ?? {}))
        const expected = `v0=${createHmac('sha256', signingSecret)
            .update(`v0:${ts}:${rawBody}`)
            .digest('hex')}`
        const a = Buffer.from(expected)
        const b = Buffer.from(sig)
        if (a.length !== b.length || !timingSafeEqual(a, b))
            return { ok: false, reason: 'signature_mismatch' }
        if (
            body.type === 'url_verification' &&
            typeof body.challenge === 'string'
        )
            return {
                ok: true,
                challengeResponse: {
                    status: 200,
                    body: { challenge: body.challenge }
                }
            }
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const config = ctx.config as SlackChannelConfig
        const form = req.body as Record<string, unknown> | undefined
        if (
            form &&
            typeof form.command === 'string' &&
            typeof form.trigger_id === 'string'
        )
            return this.parseSlashPayload(form)
        const body = (req.body ?? {}) as SlackEventOuter
        if (body.type !== 'event_callback')
            throw new UnsupportedEventError(body.type ?? 'unknown')
        const event = body.event
        if (!event) throw new UnsupportedEventError('missing_event')
        // Slack Assistant lifecycle events aren't chat; skip them silently so
        // they don't spam dropped delivery rows.
        if (
            event.type === 'assistant_thread_started' ||
            event.type === 'assistant_thread_context_changed'
        )
            throw new UnsupportedEventError(event.type, { silent: true })
        const allowedTypes = ['message', 'app_mention']
        if (!event.type || !allowedTypes.includes(event.type))
            throw new UnsupportedEventError(event.type ?? 'unknown_event_type')
        if (event.bot_id) throw new UnsupportedEventError('bot_message')
        // file_share is the subtype Slack uses for uploads; keep it (and the
        // thread_broadcast alias) but still reject edits/joins/etc.
        if (
            event.subtype &&
            event.subtype !== 'thread_broadcast' &&
            event.subtype !== 'file_share'
        )
            throw new UnsupportedEventError(`subtype:${event.subtype}`)
        if (!event.channel) throw new BadRequestException('missing channel')
        if (!event.user) throw new BadRequestException('missing user')
        // External-upload file_share messages don't always carry bot_id, so
        // drop the bot's own posts by user id too.
        if (config.botUserId && event.user === config.botUserId)
            throw new UnsupportedEventError('self_message')
        const attachments = normalizeSlackFiles(event.files)
        const text = event.text ?? ''
        // A file-only upload has blank text; keep it as long as it carries a
        // usable attachment.
        if (text.trim().length === 0 && attachments.length === 0)
            throw new UnsupportedEventError('empty_text')
        const chatType: 'private' | 'group' =
            event.channel_type === 'im' ? 'private' : 'group'
        const isMention =
            event.type === 'app_mention' ||
            chatType === 'private' ||
            (config.botUserId ? text.includes(`<@${config.botUserId}>`) : false)
        const strippedText = stripBotMention(text, config.botUserId)
        let threadId = event.thread_ts ?? null
        // Auto-thread: a top-level group message the bot will answer starts a
        // thread rooted at its own ts, so the whole exchange stays in-thread.
        // Skips text slash commands and honors the same "will be answered"
        // condition the bridge's mention gate uses.
        if (
            threadId === null &&
            chatType === 'group' &&
            config.autoThread === true &&
            config.threadIsolation &&
            (isMention || config.mentionOnly === false) &&
            !strippedText.startsWith('/') &&
            typeof event.ts === 'string'
        )
            threadId = event.ts
        const teamId = event.team ?? body.team_id ?? 'unknown'
        return {
            providerEventId: body.event_id ?? `slack-${event.ts ?? Date.now()}`,
            chatId: `${teamId}:${event.channel}`,
            chatType,
            senderId: event.user,
            senderName: null,
            text: strippedText,
            ...(attachments.length > 0 ? { attachments } : {}),
            threadId,
            isMention,
            messageId: event.ts ?? null,
            // Raw thread_ts, not the local threadId: auto-thread roots threadId
            // at the message's own ts, which is not a reply relation.
            replyToMessageId:
                event.thread_ts && event.thread_ts !== event.ts
                    ? event.thread_ts
                    : null,
            raw: body
        }
    }

    computeScopeKey(
        event: NormalizedInboundEvent,
        config: SlackChannelConfig
    ): { scopeKey: string; scopeName: string | null } {
        if (event.chatType === 'private') {
            // A DM thread (Slack Assistant container, or a manual DM thread)
            // gets its own isolated session; plain DMs keep the flat scope.
            if (event.threadId && config.threadIsolation)
                return {
                    scopeKey: `slack:${event.chatId}:${event.senderId}:thread:${event.threadId}`,
                    scopeName: null
                }
            return {
                scopeKey: `slack:${event.chatId}:${event.senderId}`,
                scopeName: null
            }
        }
        if (event.threadId && config.threadIsolation)
            return {
                scopeKey: `slack:${event.chatId}:thread:${event.threadId}`,
                scopeName: null
            }
        if (config.shareSessionInChannel)
            return {
                scopeKey: `slack:${event.chatId}`,
                scopeName: null
            }
        return {
            scopeKey: `slack:${event.chatId}:${event.senderId}`,
            scopeName: null
        }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: SlackChannelConfig
    ): InboundActorPolicy {
        const allowedIds = config.allowedUserIds ?? []
        const operatorIds = config.operatorUserIds ?? []
        const operator = operatorIds.includes(event.senderId)
        // chatId is `${teamId}:${channel}` (see parseInbound); a Slack team id
        // never contains a colon, so the first segment is the source workspace.
        if (config.teamId && event.chatId.split(':')[0] !== config.teamId)
            return { allowed: false, reason: 'team_mismatch', operator: false }
        // Operators implicitly hold chat permission: otherwise an operator on a
        // channel with a non-empty allowlist would have /model dropped by the
        // chat gate before dispatch could even check operator rights.
        const allowed =
            allowedIds.length === 0 ||
            allowedIds.includes(event.senderId) ||
            operator
        return allowed
            ? { allowed: true, operator }
            : { allowed: false, reason: 'sender_not_allowed', operator }
    }

    async downloadAttachment(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }> {
        const credentials = this.requireCredentials(ctx)
        // Slack redirects url_private (slack.com → files.slack.com); undici
        // drops Authorization on cross-origin redirects, so follow manually and
        // re-attach the bearer on each hop, re-validating the host each time.
        let url = attachment.url
        let response: Response | null = null
        for (let hop = 0; hop <= SLACK_DOWNLOAD_MAX_REDIRECTS; hop += 1) {
            assertSlackFileUrl(url)
            const controller = new AbortController()
            const timer = setTimeout(
                () => controller.abort(),
                SLACK_DOWNLOAD_TIMEOUT_MS
            )
            try {
                response = await fetch(url, {
                    method: 'GET',
                    redirect: 'manual',
                    headers: {
                        Authorization: `Bearer ${credentials.botToken}`
                    },
                    signal: controller.signal
                })
            } finally {
                clearTimeout(timer)
            }
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location')
                if (!location) break
                url = new URL(location, url).toString()
                continue
            }
            break
        }
        if (!response || !response.ok)
            throw new Error(
                `slack file download failed: http ${response?.status ?? 'no_response'}`
            )
        const contentType =
            response.headers.get('content-type')?.split(';')[0]?.trim() ||
            attachment.contentType ||
            'application/octet-stream'
        // An HTML body for a descriptor that isn't HTML is almost always a
        // login/expired-link page — reject rather than ingest it as the file.
        const declaredHtml =
            (attachment.contentType ?? '').includes('html') ||
            attachment.name.toLowerCase().endsWith('.html') ||
            attachment.name.toLowerCase().endsWith('.htm')
        if (contentType.includes('text/html') && !declaredHtml)
            throw new Error('slack file download returned html (auth failure?)')
        const bytes = await readCappedBody(response, opts.maxBytes)
        return { name: attachment.name, contentType, bytes }
    }

    private parseSlashPayload(
        form: Record<string, unknown>
    ): NormalizedInboundEvent {
        const command = String(form.command ?? '').trim()
        const argText = typeof form.text === 'string' ? form.text.trim() : ''
        const channelId =
            typeof form.channel_id === 'string' ? form.channel_id : ''
        const userId = typeof form.user_id === 'string' ? form.user_id : ''
        const teamId =
            typeof form.team_id === 'string' && form.team_id.length > 0
                ? form.team_id
                : 'unknown'
        const triggerId =
            typeof form.trigger_id === 'string' ? form.trigger_id : ''
        const responseUrl =
            typeof form.response_url === 'string' ? form.response_url : null
        const userName =
            typeof form.user_name === 'string' ? form.user_name : null
        if (!command) throw new UnsupportedEventError('slash_missing_command')
        if (!channelId) throw new BadRequestException('missing channel_id')
        if (!userId) throw new BadRequestException('missing user_id')
        // trigger_id is unique per invocation; slash payloads carry no event_id.
        const providerEventId = `slack-slash-${triggerId || command}`
        if (responseUrl)
            this.storePendingSlashResponse(providerEventId, responseUrl)
        return {
            providerEventId,
            chatId: `${teamId}:${channelId}`,
            chatType: channelId.startsWith('D') ? 'private' : 'group',
            senderId: userId,
            senderName: userName,
            // command already includes the leading slash (Slack sends "/new").
            text: argText ? `${command} ${argText}` : command,
            threadId: null,
            isMention: true,
            commandInvocation: true,
            // Slack slash requires a fast empty-body 200; the real reply is
            // delivered async via response_url.
            ackResponse: '',
            // Explicit allowlist — response_url is a capability URL and must not
            // land in event_json.
            raw: {
                command,
                text: argText,
                teamId,
                channelId,
                userId,
                triggerId
            }
        }
    }

    private storePendingSlashResponse(ref: string, responseUrl: string): void {
        const now = Date.now()
        for (const [key, entry] of this.pendingSlashResponses)
            if (entry.expiresAt <= now) this.pendingSlashResponses.delete(key)
        this.pendingSlashResponses.set(ref, {
            responseUrl,
            expiresAt: now + SLACK_RESPONSE_URL_TTL_MS
        })
    }

    private takePendingSlashResponse(ref: string): string | null {
        const entry = this.pendingSlashResponses.get(ref)
        if (!entry) return null
        this.pendingSlashResponses.delete(ref)
        if (entry.expiresAt <= Date.now()) return null
        return entry.responseUrl
    }

    private async postSlashResponse(
        responseUrl: string,
        text: string
    ): Promise<boolean> {
        const chunks = chunkText(
            slackifyMarkdown(text),
            SLACK_MAX_TEXT_LEN
        ).slice(0, SLACK_RESPONSE_URL_MAX_CHUNKS)
        if (chunks.length === 0) return false
        for (const chunk of chunks) {
            const res = await channelProviderJsonRequest({
                provider: 'slack',
                operation: 'response_url',
                url: responseUrl,
                init: {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        response_type: 'ephemeral',
                        text: chunk
                    })
                }
            })
            if (!res.ok) return false
        }
        return true
    }

    async setInboundReaction(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const target = slackTargetFromScopeKey(scopeKey)
        if (state !== 'working')
            await this.callApi(credentials.botToken, 'reactions.remove', {
                channel: target.channel,
                timestamp: providerMessageId,
                name: SLACK_ACK_REACTIONS.working
            }).catch(() => undefined)
        await this.callApi(credentials.botToken, 'reactions.add', {
            channel: target.channel,
            timestamp: providerMessageId,
            name: SLACK_ACK_REACTIONS[state]
        })
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }> {
        // Native slash reply: route to the invocation's response_url (ephemeral,
        // invisible to other channel members). Only fires when the bridge tags
        // the reply with a ref it recognizes, so ordinary agent replies can
        // never be misrouted here. Falls back to chat.postMessage on failure.
        if (opts?.interactionRef) {
            const responseUrl = this.takePendingSlashResponse(
                opts.interactionRef
            )
            if (responseUrl) {
                const delivered = await this.postSlashResponse(
                    responseUrl,
                    text
                ).catch(() => false)
                if (delivered) return {}
            }
        }
        const credentials = this.requireCredentials(ctx)
        const target = slackTargetFromScopeKey(scopeKey)
        const chunks = chunkText(slackifyMarkdown(text), SLACK_MAX_TEXT_LEN)
        let lastTs: string | undefined
        let firstTs: string | undefined
        for (const chunk of chunks) {
            const res = await this.callApi<SlackPostMessageResp>(
                credentials.botToken,
                'chat.postMessage',
                {
                    channel: target.channel,
                    text: chunk,
                    ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
                    ...(firstTs
                        ? { thread_ts: target.threadTs ?? firstTs }
                        : {})
                }
            )
            if (!firstTs) firstTs = res.ts
            lastTs = res.ts
        }
        return { providerMessageId: lastTs }
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string
    ): Promise<PreviewHandle> {
        const credentials = this.requireCredentials(ctx)
        const target = slackTargetFromScopeKey(scopeKey)
        const res = await this.callApi<SlackPostMessageResp>(
            credentials.botToken,
            'chat.postMessage',
            {
                channel: target.channel,
                text: '⏳ thinking…',
                ...(target.threadTs ? { thread_ts: target.threadTs } : {})
            }
        )
        return {
            providerMessageId: res.ts,
            // Keep the thread root so the fallback + continuation chunks stay in
            // the same thread even if the in-place edit fails.
            raw: {
                channel: res.channel ?? target.channel,
                threadTs: target.threadTs
            }
        }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const channel = (handle.raw as { channel?: string } | undefined)
            ?.channel
        if (!channel) return
        const text = truncate(
            slackifyMarkdown(partial),
            SLACK_MAX_TEXT_LEN - 32
        )
        await this.callApi(credentials.botToken, 'chat.update', {
            channel,
            ts: handle.providerMessageId,
            text: `${text}\n\n_⏳ streaming…_`
        }).catch((err) => {
            this.logger.warn(
                `chat.update (preview) failed: ${(err as Error).message}`
            )
        })
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        const credentials = this.requireCredentials(ctx)
        const raw = handle.raw as
            | { channel?: string; threadTs?: string | null }
            | undefined
        const channel = raw?.channel
        if (!channel) return
        const threadTs = raw?.threadTs ?? null
        const chunks = chunkText(
            slackifyMarkdown(finalText),
            SLACK_MAX_TEXT_LEN
        )
        const head = chunks[0] ?? '(empty)'
        await this.callApi(credentials.botToken, 'chat.update', {
            channel,
            ts: handle.providerMessageId,
            text: head
        }).catch(async (err) => {
            this.logger.warn(
                `chat.update (final) failed, falling back to chat.postMessage: ${(err as Error).message}`
            )
            // Keep the fallback in the same thread as the preview it replaces.
            await this.callApi(credentials.botToken, 'chat.postMessage', {
                channel,
                text: head,
                ...(threadTs ? { thread_ts: threadTs } : {})
            })
        })
        for (let i = 1; i < chunks.length; i += 1) {
            // Continuation chunks thread under the real root when there is one,
            // else under the preview message (Slack requires a parent ts, not a
            // reply ts).
            await this.callApi(credentials.botToken, 'chat.postMessage', {
                channel,
                text: chunks[i],
                thread_ts: threadTs ?? handle.providerMessageId
            })
        }
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const credentials = this.requireCredentials(ctx)
        const target = slackTargetFromScopeKey(scopeKey)
        // Slack's external-upload flow (files.upload is deprecated): reserve an
        // upload URL per file, PUT the raw bytes, then complete the batch into
        // the channel/thread. All-or-nothing (mirrors Discord's single send) —
        // the bridge treats a throw as non-fatal since the text reply landed.
        const uploaded: Array<{ id: string; title: string }> = []
        for (const file of files) {
            const upload = await this.callApi<SlackUploadUrlResp>(
                credentials.botToken,
                'files.getUploadURLExternal',
                { filename: file.name, length: file.bytes.length }
            )
            if (!upload.upload_url || !upload.file_id)
                throw new Error('slack getUploadURLExternal returned no url')
            const put = await channelProviderJsonRequest({
                provider: 'slack',
                operation: 'files.uploadExternalBytes',
                url: upload.upload_url,
                init: {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    // Fresh Uint8Array view so the body type matches BodyInit
                    // (a Node Buffer<ArrayBufferLike> is not assignable).
                    body: new Uint8Array(file.bytes)
                }
            })
            if (!put.ok)
                throw new Error(`slack file upload failed: http ${put.status}`)
            uploaded.push({ id: upload.file_id, title: file.name })
        }
        await this.callApi(
            credentials.botToken,
            'files.completeUploadExternal',
            {
                files: uploaded,
                channel_id: target.channel,
                ...(target.threadTs ? { thread_ts: target.threadTs } : {})
            }
        )
        return {}
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as SlackChannelCredentials | null
        if (!credentials?.botToken)
            return { ok: false, message: '✗ botToken missing' }
        const lines: string[] = []
        let ok = true
        try {
            const auth = await this.callApi<SlackAuthTest>(
                credentials.botToken,
                'auth.test',
                {}
            )
            lines.push(
                `✓ auth.test passed: team=${auth.team ?? '(unknown)'} bot=${auth.user ?? '(unknown)'}`
            )
        } catch (err) {
            return {
                ok: false,
                message: `✗ auth.test failed: ${(err as Error).message}`
            }
        }
        if (ctx.channel.status === 'draft') {
            ok = false
            lines.push(
                '✗ webhook URL not yet verified — paste the inbound URL into your Slack app under Event Subscriptions and trigger url_verification'
            )
        } else if (ctx.channel.status === 'error') {
            ok = false
            lines.push(
                `✗ channel status is error — ${ctx.channel.lastErrorMessage ?? 'unknown'}`
            )
        } else lines.push(`✓ channel status: ${ctx.channel.status}`)
        return { ok, message: lines.join('\n') }
    }

    private requireCredentials(ctx: ChannelContext): SlackChannelCredentials {
        const credentials = ctx.credentials as SlackChannelCredentials | null
        if (!credentials?.botToken)
            throw new BadRequestException('slack botToken missing')
        return credentials
    }

    private async callApi<T = Record<string, unknown>>(
        botToken: string,
        method: string,
        params: Record<string, unknown>
    ): Promise<T> {
        const res = await channelProviderJsonRequest<Record<string, unknown>>({
            provider: 'slack',
            operation: method,
            url: `${SLACK_API_BASE}/${method}`,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${botToken}`,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify(params)
            }
        })
        const json = res.json ?? {}
        if (!res.ok) {
            const message = `slack ${method} http ${res.status}: ${res.text.slice(0, 300)}`
            if (res.status === 429)
                throw new ChannelSendError('rate_limited', message, {
                    retryAfterMs: res.retryAfterMs
                })
            throw new Error(message)
        }
        if ((json as { ok?: boolean }).ok !== true) {
            const code = (json as { error?: string }).error ?? 'unknown'
            const message = `slack ${method} error: ${code}`
            const kind = classifySlackError(code)
            if (kind === null) throw new Error(message)
            throw new ChannelSendError(kind, message)
        }
        return json as T
    }
}

interface SlackAuthTest {
    ok: boolean
    url?: string
    team?: string
    user?: string
    user_id?: string
    team_id?: string
}

interface SlackPostMessageResp {
    ok: boolean
    channel?: string
    ts: string
}

interface SlackUploadUrlResp {
    ok: boolean
    upload_url?: string
    file_id?: string
}

const normalizeSlackFiles = (
    files: SlackInboundFile[] | undefined
): NormalizedInboundAttachment[] => {
    if (!Array.isArray(files)) return []
    const out: NormalizedInboundAttachment[] = []
    for (const file of files) {
        if (file.mode === 'tombstone') continue
        // url_private_download forces Content-Disposition: attachment; both need
        // the bot token, so neither is a secret to persist.
        const url = file.url_private_download ?? file.url_private
        if (typeof url !== 'string' || url.length === 0) continue
        out.push({
            url,
            name: file.name ?? file.title ?? 'file',
            contentType:
                typeof file.mimetype === 'string' ? file.mimetype : null,
            size: typeof file.size === 'number' ? file.size : null
        })
    }
    return out
}

const assertSlackFileUrl = (raw: string): void => {
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        throw new Error('slack file url is not a valid url')
    }
    if (parsed.protocol !== 'https:')
        throw new Error('slack file url must be https')
    const host = parsed.hostname.toLowerCase()
    if (host !== 'slack.com' && !host.endsWith('.slack.com'))
        throw new Error(`slack file url host not allowed: ${host}`)
}

const readCappedBody = async (
    response: Response,
    maxBytes: number
): Promise<Buffer> => {
    const reader = response.body?.getReader()
    if (!reader) {
        const buf = Buffer.from(await response.arrayBuffer())
        if (buf.length > maxBytes)
            throw new Error(`slack file exceeds ${maxBytes} bytes`)
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
            throw new Error(`slack file exceeds ${maxBytes} bytes`)
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

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
    return out
}

const slackTargetFromScopeKey = (
    scopeKey: string
): { channel: string; threadTs: string | null } => {
    const segments = scopeKey.split(':')
    if (segments.length < 3) throw new Error(`invalid scopeKey ${scopeKey}`)
    const channel = segments[2]
    // The 'thread' marker sits at a different index for group
    // (slack:team:channel:thread:ts) vs private-thread
    // (slack:team:channel:user:thread:ts) scopes; find it rather than assume a
    // fixed position. Slack ids/timestamps never equal the literal 'thread'.
    const marker = segments.indexOf('thread', 3)
    if (marker !== -1 && segments[marker + 1])
        return { channel, threadTs: segments[marker + 1] }
    return { channel, threadTs: null }
}

const stripBotMention = (
    text: string,
    botUserId: string | null | undefined
): string => {
    if (!botUserId) return text
    return text
        .replace(new RegExp(`<@${botUserId}>`, 'g'), '')
        .replace(/^[\s,:]+/, '')
        .trim()
}

const slackifyMarkdown = (text: string): string =>
    text
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '*$1*')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')

const truncate = (text: string, max: number): string => {
    if (text.length <= max) return text
    return `${text.slice(0, max - 1)}…`
}

// Generate a Slack app manifest (JSON) for a channel: same 11 commands as every
// other surface (single source of truth = SLASH_COMMAND_SPECS), all pointing at
// this channel's inbound URL, plus the bot scopes and event subscriptions
// Phase 1 needs (files:* included so attachments work without a reinstall).
export const buildSlackAppManifest = (opts: {
    name: string
    hooksUrl: string
}): Record<string, unknown> => {
    const displayName = opts.name.trim().slice(0, 35) || 'Manyfold Agent'
    const slashCommands = SLASH_COMMAND_SPECS.map((spec) => {
        const usageHint = spec.arg
            ? spec.usage
                  .replace(new RegExp(`^/${spec.name}\\s*`), '')
                  .trim()
            : ''
        return {
            command: `/${spec.name}`,
            url: opts.hooksUrl,
            description: spec.description.slice(0, 2000),
            ...(usageHint ? { usage_hint: usageHint } : {}),
            should_escape: false
        }
    })
    return {
        _metadata: { major_version: 1, minor_version: 1 },
        display_information: { name: displayName },
        features: {
            bot_user: {
                display_name: displayName.slice(0, 80),
                always_online: true
            },
            slash_commands: slashCommands
        },
        oauth_config: {
            scopes: {
                bot: [
                    'app_mentions:read',
                    'channels:history',
                    'groups:history',
                    'im:history',
                    'mpim:history',
                    'chat:write',
                    'commands',
                    'files:read',
                    'files:write'
                ]
            }
        },
        settings: {
            event_subscriptions: {
                request_url: opts.hooksUrl,
                bot_events: [
                    'app_mention',
                    'message.channels',
                    'message.groups',
                    'message.im',
                    'message.mpim'
                ]
            },
            interactivity: { is_enabled: false },
            org_deploy_enabled: false,
            socket_mode_enabled: false,
            token_rotation_enabled: false
        }
    }
}
