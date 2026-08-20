import type {
    ChannelTestResult,
    FakeChannelConfig,
    FakeChannelCredentials
} from '@manyfold/shared'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { UnsupportedEventError } from '../channel-provider'
import type {
    ChannelCommandView,
    ChannelContext,
    ChannelHandle,
    ChannelHistoryContext,
    ChannelProvider,
    ChannelSendTarget,
    ChannelTurnTapEvent,
    InboundActorPolicy,
    InboundHandler,
    InboundRequest,
    NormalizedInboundAction,
    NormalizedInboundAttachment,
    NormalizedInboundEvent,
    OutboundAttachment,
    PreviewHandle,
    SendTextOptions,
    SignatureCheck
} from '../channel-provider'
import {
    parseFinalMessageMode,
    parseHistoryBackfillLimit,
    parseProgressMode,
    parseResetOnIdleMins
} from '../config-helpers'

interface FakeInboundActionBody {
    eventId?: string
    chatId?: string
    chatType?: 'private' | 'group'
    senderId?: string
    senderName?: string | null
    threadId?: string | null
    action?: string
    targetChannelSessionId?: string | null
    targetPage?: number | null
    scopeKey?: string | null
}

interface FakeInboundBody {
    eventId?: string
    chatId?: string
    chatType?: 'private' | 'group'
    senderId?: string
    senderName?: string | null
    text?: string
    threadId?: string | null
    isMention?: boolean
    messageId?: string | null
    replyToMessageId?: string | null
    commandInvocation?: boolean
    ackResponse?: unknown
    unsupported?: string
    unsupportedSilent?: boolean
}

@Injectable()
export class FakeChannelProvider implements ChannelProvider {
    readonly name = 'fake' as const
    previewUpdateMinIntervalMs?: number
    private readonly logger = new Logger(FakeChannelProvider.name)
    private readonly handlers = new Map<string, InboundHandler>()
    private readonly outbound = new Map<string, OutboundCapture[]>()
    // Test knobs for history backfill: canned block (a plain string is
    // normalized to { text }; a function may throw to exercise the bridge's
    // fail-open path) and a record of each hook call.
    historyContextResult:
        | string
        | ChannelHistoryContext
        | null
        | (() => string | ChannelHistoryContext | null) = null
    readonly historyFetches: Array<{
        channelId: string
        scopeKey: string
        limit: number
        providerEventId: string
        threadFresh?: boolean
    }> = []

    validateConfig(config: unknown): FakeChannelConfig {
        if (config === null || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as {
            note?: unknown
            progressMode?: unknown
            finalMessageMode?: unknown
            replyHud?: unknown
            outboundFiles?: unknown
            historyBackfill?: unknown
            historyBackfillLimit?: unknown
            contextProjection?: unknown
            agentManagedReply?: unknown
            resetOnIdleMins?: unknown
        }
        if (
            c.note !== undefined &&
            c.note !== null &&
            typeof c.note !== 'string'
        )
            throw new BadRequestException('config.note must be a string')
        return {
            note: typeof c.note === 'string' ? c.note : null,
            progressMode: parseProgressMode(c.progressMode),
            finalMessageMode: parseFinalMessageMode(c.finalMessageMode),
            replyHud: c.replyHud === true,
            outboundFiles: c.outboundFiles !== false,
            historyBackfill: c.historyBackfill !== false,
            historyBackfillLimit: parseHistoryBackfillLimit(
                c.historyBackfillLimit
            ),
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true,
            resetOnIdleMins: parseResetOnIdleMins(c.resetOnIdleMins)
        }
    }

    validateCredentials(credentials: unknown): FakeChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const secret = (credentials as { secret?: unknown }).secret
        if (
            secret !== undefined &&
            secret !== null &&
            typeof secret !== 'string'
        )
            throw new BadRequestException('credentials.secret must be a string')
        return { secret: typeof secret === 'string' ? secret : null }
    }

    managesConnection(): boolean {
        return true
    }

    async start(
        ctx: ChannelContext,
        onInbound: InboundHandler
    ): Promise<ChannelHandle> {
        this.handlers.set(ctx.channel.id, onInbound)
        return {
            status: 'connected',
            stop: async () => {
                this.handlers.delete(ctx.channel.id)
            }
        }
    }

    parseInbound(req: InboundRequest): NormalizedInboundEvent {
        const body = (req.body ?? {}) as FakeInboundBody
        if (typeof body.unsupported === 'string')
            throw new UnsupportedEventError(body.unsupported, {
                silent: body.unsupportedSilent === true
            })
        if (typeof body.text !== 'string' || !body.text.trim())
            throw new BadRequestException('text is required')
        if (!body.chatId) throw new BadRequestException('chatId is required')
        if (!body.senderId)
            throw new BadRequestException('senderId is required')
        return {
            providerEventId: body.eventId ?? `fake-${Date.now()}`,
            chatId: body.chatId,
            chatType: body.chatType ?? 'private',
            senderId: body.senderId,
            senderName: body.senderName ?? null,
            text: body.text,
            threadId: body.threadId ?? null,
            isMention: body.isMention ?? false,
            messageId: body.messageId ?? null,
            replyToMessageId: body.replyToMessageId ?? null,
            ...(body.commandInvocation === true
                ? { commandInvocation: true }
                : {}),
            ...(body.ackResponse !== undefined
                ? { ackResponse: body.ackResponse }
                : {}),
            raw: body
        }
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as FakeChannelCredentials | null
        const expected = credentials?.secret
        if (!expected) return { ok: true }
        const provided = req.headers['x-fake-secret']
        if (provided && provided === expected) return { ok: true }
        return { ok: false, reason: 'signature_mismatch' }
    }

    computeScopeKey(event: NormalizedInboundEvent): {
        scopeKey: string
        scopeName: string | null
    } {
        const scopeKey =
            event.chatType === 'private'
                ? `fake:${event.chatId}:${event.senderId}`
                : event.threadId
                  ? `fake:${event.chatId}:thread:${event.threadId}`
                  : `fake:${event.chatId}:${event.senderId}`
        return { scopeKey, scopeName: event.senderName ?? null }
    }

    // Test knob: override to simulate a provider with an actor policy. Default
    // allows everyone with operator rights (matches the bridge's no-hook path).
    actorPolicy:
        | InboundActorPolicy
        | ((event: NormalizedInboundEvent) => InboundActorPolicy)
        | null = null

    evaluateInboundActor(event: NormalizedInboundEvent): InboundActorPolicy {
        const policy = this.actorPolicy
        if (policy === null) return { allowed: true, operator: true }
        return typeof policy === 'function' ? policy(event) : policy
    }

    // Left unset by default so existing URL-path bridge tests keep exercising
    // resolveFileInput; a test assigns it to cover the provider-download seam.
    downloadAttachment?: (
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ) => Promise<{ name: string; contentType: string; bytes: Buffer }>

    // Left unset by default so existing turn-text assertions stay exact; a
    // test assigns it to cover the reply-context seam.
    fetchReplyContext?: (
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ) => Promise<string | null>

    // Left unset by default so existing scope-name assertions stay exact; a
    // test assigns it to cover the sender-name enrichment seam.
    resolveSenderName?: (
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ) => Promise<string | null>

    async fetchHistoryContext(
        ctx: ChannelContext,
        event: NormalizedInboundEvent,
        opts: { scopeKey: string; limit: number }
    ): Promise<ChannelHistoryContext | null> {
        this.historyFetches.push({
            channelId: ctx.channel.id,
            scopeKey: opts.scopeKey,
            limit: opts.limit,
            providerEventId: event.providerEventId,
            threadFresh: event.threadFresh
        })
        const raw = this.historyContextResult
        const result = typeof raw === 'function' ? raw() : raw
        if (result === null) return null
        return typeof result === 'string' ? { text: result } : result
    }

    // Test knob: a function may be assigned to make scope-addressed sends
    // fail.
    sendTextResult: (() => void) | null = null

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }> {
        this.sendTextResult?.()
        const id = `fake-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        this.capture(ctx.channel.id, {
            kind: 'final',
            scopeKey,
            text,
            id,
            replyToProviderMessageId: opts?.replyToProviderMessageId ?? null,
            nonConversational: opts?.nonConversational === true,
            terminal: opts?.terminal ?? null,
            interactionRef: opts?.interactionRef ?? null
        })
        return { providerMessageId: id }
    }

    // Deliberately absent by default: the bridge must leave a provider without
    // this hook byte-identical, and there are tests asserting exactly that.
    // enableTurnEventCapture() opts a harness in.
    onTurnEvent?: ChannelProvider['onTurnEvent']

    // Test knob. `gate` lets a test hold a projection open to prove the
    // terminal reply waits for it.
    enableTurnEventCapture(opts: { gate?: () => Promise<void> } = {}): void {
        this.onTurnEvent = async (ctx, scopeKey, event, info) => {
            if (opts.gate) await opts.gate()
            this.capture(ctx.channel.id, {
                kind: 'turn-event',
                scopeKey,
                event,
                chatSessionId: info.chatSessionId,
                channelSessionId: info.channelSessionId
            })
        }
    }

    // Test knob: a function may be assigned to make direct sends fail.
    sendDirectResult: (() => void) | null = null

    async sendDirect(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }> {
        this.sendDirectResult?.()
        const id = `fake-direct-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
        this.capture(ctx.channel.id, { kind: 'direct', target, text, id })
        return { providerMessageId: id }
    }

    // Test knob: a function may be assigned to make direct file sends fail.
    sendDirectAttachmentsResult: (() => void) | null = null

    async sendDirectAttachments(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        this.sendDirectAttachmentsResult?.()
        const id = `fake-direct-files-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
        this.capture(ctx.channel.id, {
            kind: 'direct-attachments',
            target,
            id,
            files: files.map((f) => ({
                name: f.name,
                contentType: f.contentType,
                size: f.bytes.length
            }))
        })
        return { providerMessageId: id }
    }

    async deleteMessage(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string
    ): Promise<void> {
        this.capture(ctx.channel.id, {
            kind: 'delete',
            scopeKey,
            id: providerMessageId
        })
    }

    async sendAttachments(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }> {
        const id = `fake-files-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
        this.capture(ctx.channel.id, {
            kind: 'attachments',
            scopeKey,
            id,
            files: files.map((f) => ({
                name: f.name,
                contentType: f.contentType,
                size: f.bytes.length
            }))
        })
        return { providerMessageId: id }
    }

    async sendCommandView(
        ctx: ChannelContext,
        scopeKey: string,
        view: ChannelCommandView
    ): Promise<{ providerMessageId?: string }> {
        const id = `fake-view-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
        this.capture(ctx.channel.id, {
            kind: 'command-view',
            scopeKey,
            view,
            id
        })
        return { providerMessageId: id }
    }

    parseInboundAction(req: InboundRequest): NormalizedInboundAction | null {
        const body = req.body as FakeInboundActionBody | null
        if (!body || typeof body !== 'object') return null
        if (typeof body.action !== 'string' || !body.action.trim()) return null
        if (typeof body.chatId !== 'string' || !body.chatId) return null
        if (typeof body.senderId !== 'string' || !body.senderId) return null
        return {
            providerEventId: body.eventId ?? `fake-act-${Date.now()}`,
            chatId: body.chatId,
            chatType: body.chatType ?? 'private',
            senderId: body.senderId,
            senderName: body.senderName ?? null,
            threadId: body.threadId ?? null,
            action: body.action,
            targetChannelSessionId: body.targetChannelSessionId ?? null,
            targetPage:
                typeof body.targetPage === 'number' ? body.targetPage : null,
            scopeKey: body.scopeKey ?? null,
            raw: body
        }
    }

    async setInboundReaction(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void> {
        this.capture(ctx.channel.id, {
            kind: 'reaction',
            scopeKey,
            id: providerMessageId,
            state
        })
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: {
            triggerProviderMessageId?: string | null
            chatSessionId?: string
        }
    ): Promise<() => void> {
        this.capture(ctx.channel.id, {
            kind: 'typing-start',
            scopeKey,
            triggerProviderMessageId: opts?.triggerProviderMessageId ?? null,
            chatSessionId: opts?.chatSessionId ?? null
        })
        let stopped = false
        return () => {
            if (stopped) return
            stopped = true
            this.capture(ctx.channel.id, { kind: 'typing-stop', scopeKey })
        }
    }

    async sendPreviewStart(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: SendTextOptions
    ): Promise<PreviewHandle> {
        const id = `fake-preview-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`
        this.capture(ctx.channel.id, {
            kind: 'preview-start',
            scopeKey,
            id,
            replyToProviderMessageId: opts?.replyToProviderMessageId ?? null
        })
        return { providerMessageId: id }
    }

    async updatePreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void> {
        this.capture(ctx.channel.id, {
            kind: 'preview-update',
            id: handle.providerMessageId,
            text: partial
        })
    }

    async finishPreview(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void> {
        this.capture(ctx.channel.id, {
            kind: 'preview-finish',
            id: handle.providerMessageId,
            text: finalText
        })
    }

    async test(): Promise<ChannelTestResult> {
        return { ok: true, message: 'fake provider always reachable' }
    }

    async injectInbound(
        channelId: string,
        body: FakeInboundBody
    ): Promise<void> {
        const handler = this.handlers.get(channelId)
        if (!handler) throw new BadRequestException('channel not started')
        const event: NormalizedInboundEvent = {
            providerEventId: body.eventId ?? `fake-${Date.now()}`,
            chatId: body.chatId ?? 'test-chat',
            chatType: body.chatType ?? 'private',
            senderId: body.senderId ?? 'test-user',
            senderName: body.senderName ?? null,
            text: body.text ?? '',
            threadId: body.threadId ?? null,
            isMention: body.isMention ?? false,
            messageId: body.messageId ?? null,
            replyToMessageId: body.replyToMessageId ?? null,
            raw: body
        }
        await handler(event)
    }

    drainOutbound(channelId: string): OutboundCapture[] {
        const entries = this.outbound.get(channelId) ?? []
        this.outbound.delete(channelId)
        return entries
    }

    private capture(channelId: string, entry: OutboundCapture): void {
        const list = this.outbound.get(channelId) ?? []
        list.push(entry)
        this.outbound.set(channelId, list)
        this.logger.debug?.(`fake outbound channel=${channelId} ${entry.kind}`)
    }
}

interface OutboundCaptureFinal {
    kind: 'final'
    scopeKey: string
    text: string
    id: string
    replyToProviderMessageId?: string | null
    nonConversational?: boolean
    terminal?: 'final' | 'error' | 'cancelled' | null
    interactionRef?: string | null
}

interface OutboundCapturePreviewStart {
    kind: 'preview-start'
    scopeKey: string
    id: string
    replyToProviderMessageId?: string | null
}

interface OutboundCapturePreviewUpdate {
    kind: 'preview-update'
    id: string
    text: string
}

interface OutboundCapturePreviewFinish {
    kind: 'preview-finish'
    id: string
    text: string
}

interface OutboundCaptureCommandView {
    kind: 'command-view'
    scopeKey: string
    view: ChannelCommandView
    id: string
}

interface OutboundCaptureTypingStart {
    kind: 'typing-start'
    scopeKey: string
    triggerProviderMessageId?: string | null
    chatSessionId?: string | null
}

interface OutboundCaptureTurnEvent {
    kind: 'turn-event'
    scopeKey: string
    event: ChannelTurnTapEvent
    chatSessionId: string
    channelSessionId: string
}

interface OutboundCaptureTypingStop {
    kind: 'typing-stop'
    scopeKey: string
}

interface OutboundCaptureDelete {
    kind: 'delete'
    scopeKey: string
    id: string
}

interface OutboundCaptureAttachments {
    kind: 'attachments'
    scopeKey: string
    id: string
    files: Array<{ name: string; contentType: string; size: number }>
}

interface OutboundCaptureDirect {
    kind: 'direct'
    target: ChannelSendTarget
    text: string
    id: string
}

interface OutboundCaptureDirectAttachments {
    kind: 'direct-attachments'
    target: ChannelSendTarget
    id: string
    files: Array<{ name: string; contentType: string; size: number }>
}

interface OutboundCaptureReaction {
    kind: 'reaction'
    scopeKey: string
    id: string
    state: 'working' | 'done' | 'failed'
}

export type OutboundCapture =
    | OutboundCaptureFinal
    | OutboundCapturePreviewStart
    | OutboundCapturePreviewUpdate
    | OutboundCapturePreviewFinish
    | OutboundCaptureCommandView
    | OutboundCaptureTypingStart
    | OutboundCaptureTurnEvent
    | OutboundCaptureTypingStop
    | OutboundCaptureDelete
    | OutboundCaptureAttachments
    | OutboundCaptureDirect
    | OutboundCaptureDirectAttachments
    | OutboundCaptureReaction
