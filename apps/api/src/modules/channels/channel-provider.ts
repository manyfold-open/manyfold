import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelProviderName,
    ChannelTestResult
} from '@manyfold/shared'
import type { ChannelRow } from '@manyfold/db'

export interface RegistrationResult {
    ok: boolean
    message?: string
    activate?: boolean
    configPatch?: ChannelConfig
    credentialsPatch?: ChannelCredentials
}

export interface NormalizedInboundAttachment {
    url: string
    name: string
    contentType?: string | null
    size?: number | null
}

// An attachment surfaced by history backfill, carrying provenance so the
// backfill text can label it and telemetry can trace it back to its source
// platform message. The url doubles as the dedupe key against the triggering
// event's own attachments.
export interface ChannelHistoryAttachment extends NormalizedInboundAttachment {
    authorName?: string | null
    providerMessageId?: string | null
}

// Structured history backfill result. attachments are ordered by descending
// materialization priority (e.g. thread starter first, then newest-first);
// the bridge selects a bounded number of them, downloads through the same
// pipeline as live inbound attachments, and marks the rest unavailable in the
// text via their labels.
export interface ChannelHistoryContext {
    text: string
    attachments?: ChannelHistoryAttachment[]
}

// The label a provider embeds in its backfill text for a history attachment.
// The bridge regenerates the same string from the descriptor to mark the ones
// that did not materialize, so both sides must build it from this helper.
export const historyAttachmentLabel = (
    att: ChannelHistoryAttachment
): string => {
    const from = att.authorName ? ` from ${att.authorName}` : ''
    const message = att.providerMessageId
        ? `, message ${att.providerMessageId}`
        : ''
    return `[historical attachment${from}${message}: ${att.name}]`
}

export const historyAttachmentUnavailableLabel = (
    att: ChannelHistoryAttachment
): string => `${historyAttachmentLabel(att).slice(0, -1)} — unavailable]`

export interface NormalizedInboundEvent {
    providerEventId: string
    chatId: string
    chatType: 'private' | 'group'
    senderId: string
    senderName?: string | null
    text: string
    attachments?: NormalizedInboundAttachment[]
    threadId?: string | null
    isMention: boolean
    // This message's own provider message id, distinct from providerEventId
    // (delivery dedup key). Feeds the context projection so the agent can cite
    // and correlate platform messages. Survives queue/replay.
    messageId?: string | null
    // Provider message id this inbound message was itself sent as a reply to
    // (e.g. Lark parent_id, Discord referenced_message). Lets the agent tie a
    // reply back to the question it answers. Survives queue/replay.
    replyToMessageId?: string | null
    // Provider message id this event should be answered as a native reply to
    // (e.g. Discord message_reference). Null when the platform can't reference
    // it or replying would be noise (DMs). Survives queue/replay.
    replyTargetId?: string | null
    // Set when the provider auto-created the thread for this event; history
    // backfill must skip a brand-new thread that has no prior messages.
    // Survives queue/replay.
    threadFresh?: boolean
    // This event is an explicit native command invocation (e.g. a Slack slash
    // command), not chat. An unrecognized command must get command help and
    // never reach the agent. Survives queue/replay.
    commandInvocation?: boolean
    // Body the webhook controller should return for this request when the
    // platform's ack contract needs something other than the default (e.g.
    // Slack slash commands want an empty-body 200). Not persisted for replay.
    ackResponse?: unknown
    raw: unknown
}

// Explicit destination for an agent-initiated send, independent of any
// inbound-derived scope key: a chat, a provider user (DM), or a native reply
// to a specific provider message.
export type ChannelSendTarget =
    | { kind: 'chat'; chatId: string }
    | { kind: 'user'; userId: string }
    | { kind: 'reply'; messageId: string }

export interface SendTextOptions {
    replyToProviderMessageId?: string | null
    // Bot housekeeping (slash replies, queue notices) that never enters the
    // chat transcript. Providers with history backfill must not treat such a
    // message as the "everything before this is already in-transcript" boundary.
    nonConversational?: boolean
    // Opaque per-invocation handle for a native command reply (e.g. a Slack
    // slash command's response_url). The provider routes the reply back to that
    // invocation when it recognizes the ref, else sends a normal message.
    interactionRef?: string
    // Terminal disposition of the turn this text concludes. Platforms that
    // derive conversation state from the message itself (Linear infers session
    // state from the last emitted activity type) need it to pick the right
    // terminal primitive; every other provider ignores it. Absent on
    // non-terminal sends (queue notices, slash replies, agent sends), and
    // persisted on the delivery row so a swept retry keeps the disposition.
    terminal?: 'final' | 'error' | 'cancelled'
}

export interface OutboundAttachment {
    name: string
    contentType: string
    bytes: Buffer
}

export interface SignatureCheck {
    ok: boolean
    reason?: string
    challengeResponse?: { status: number; body: unknown }
}

export interface InboundRequest {
    headers: Record<string, string>
    body: unknown
    rawBody?: string
}

export interface ChannelHandle {
    status: 'connected' | 'connecting' | 'error'
    stop: () => Promise<void>
}

export interface PreviewHandle {
    providerMessageId: string
    raw?: unknown
}

export interface SessionCardItem {
    index: number
    channelSessionId: string
    chatSessionId: string
    displayName: string | null
    chatTitle: string | null
    isActive: boolean
    archivedAt: Date | null
    lastActivityAt: Date | null
}

export type ChannelCommandView =
    | { kind: 'text'; text: string }
    | {
          kind: 'session_list'
          text: string
          items: SessionCardItem[]
          page: { current: number; total: number }
      }
    | { kind: 'session_detail'; text: string; item: SessionCardItem | null }

export interface NormalizedInboundAction {
    providerEventId: string
    chatId: string
    chatType: 'private' | 'group'
    senderId: string
    senderName: string | null
    threadId: string | null
    action: string
    targetChannelSessionId: string | null
    targetPage: number | null
    scopeKey: string | null
    raw: unknown
}

// Mid-turn progress a provider can project onto its platform as first-class
// entities (Linear renders tool calls as action activities and a TodoWrite as
// the session plan). Structurally a subset of the chat adapter's emitted
// events, restated here so the channel contract does not depend on the chat
// module and does not drift when an adapter adds a field.
export type ChannelTurnTapEvent =
    | { type: 'tool_call'; toolCallId: string; toolName: string; args: unknown }
    | { type: 'tool_result'; toolCallId: string; result: unknown }
    | { type: 'thinking'; text: string }

export type InboundHandler = (event: NormalizedInboundEvent) => Promise<void>

// Delivered by connection-owning providers (websocket) when the platform
// pushes an interactive-component action (e.g. a Lark card button press)
// over the live connection instead of the webhook.
export type ActionHandler = (action: NormalizedInboundAction) => Promise<void>

export type ChannelStatusKind = 'connected' | 'connecting' | 'error'

export type StatusHandler = (
    status: ChannelStatusKind,
    detail?: { message?: string }
) => void

export interface ChannelContext {
    channel: ChannelRow
    config: ChannelConfig
    credentials: ChannelCredentials | null
}

export class UnsupportedEventError extends Error {
    // When true, the controller skips even the recorded 'dropped' delivery row
    // (e.g. Slack assistant lifecycle events that are pure noise).
    readonly silent: boolean
    constructor(
        public readonly eventType: string,
        opts: { silent?: boolean } = {}
    ) {
        super(`unsupported event type: ${eventType}`)
        this.name = 'UnsupportedEventError'
        this.silent = opts.silent === true
    }
}

// Verdict on whether an inbound external actor (e.g. a Slack user) may drive
// the agent, and whether they may run agent-wide commands. Kept separate from
// Manyfold account authentication: these identities never authenticate a user.
export interface InboundActorPolicy {
    allowed: boolean
    // Machine-readable rejection reason recorded on the dropped delivery when
    // allowed is false (e.g. 'sender_not_allowed', 'team_mismatch').
    reason?: string
    operator: boolean
}

export interface ChannelProvider {
    readonly name: ChannelProviderName
    // Minimum interval between streaming-preview edits for this platform
    // (edit-rate budgets differ: Discord ~5 edits/5s, Telegram flood control
    // counts edits). The bridge falls back to its own default when absent.
    readonly previewUpdateMinIntervalMs?: number
    // strict enables write-time-only checks (channel create/update). Runtime
    // parsing must stay lenient so existing stored configs keep working.
    validateConfig(config: unknown, opts?: { strict?: boolean }): ChannelConfig
    validateCredentials(credentials: unknown): ChannelCredentials | null
    // True when start() owns a live connection (websocket/sync loop) whose
    // loss is recoverable by restarting the handle. The manager only
    // auto-reconnects errored channels for these; webhook-style providers
    // return noop handles whose restart would fake the channel healthy.
    managesConnection?(config: ChannelConfig): boolean
    start(
        ctx: ChannelContext,
        onInbound: InboundHandler,
        onStatus?: StatusHandler,
        onAction?: ActionHandler
    ): Promise<ChannelHandle>
    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent
    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck
    computeScopeKey(
        event: NormalizedInboundEvent,
        config: ChannelConfig
    ): { scopeKey: string; scopeName: string | null }
    // Decide whether this inbound event's external actor may drive the agent
    // and whether they hold operator rights. Providers without an actor model
    // omit this; the bridge then treats every actor as allowed + operator.
    evaluateInboundActor?(
        event: NormalizedInboundEvent,
        config: ChannelConfig
    ): InboundActorPolicy
    sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }>
    // Agent-initiated outbound send to an explicit target. Providers that omit
    // this do not support agent channel send.
    sendDirect?(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        text: string
    ): Promise<{ providerMessageId?: string }>
    // Agent-initiated file send to an explicit target (the target-addressed
    // sibling of sendAttachments). Providers that omit this do not support
    // agent file send.
    sendDirectAttachments?(
        ctx: ChannelContext,
        target: ChannelSendTarget,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }>
    // After a crash left a send attempt's outcome unknown (the delivery row
    // still carries sendAttemptStartedAt), check whether the text actually
    // reached the platform, e.g. by scanning recent own-authored messages.
    // 'sent' must be high-precision: a false positive silently drops the
    // reply, while 'not_sent'/'unknown' merely risks a duplicate on retry.
    // Providers that omit this accept the duplicate risk (the sweep retries).
    reconcileSend?(
        ctx: ChannelContext,
        opts: {
            scopeKey: string
            target: ChannelSendTarget | null
            text: string
            attemptStartedAt: Date
        }
    ): Promise<{
        outcome: 'sent' | 'not_sent' | 'unknown'
        providerMessageId?: string
    }>
    sendCommandView?(
        ctx: ChannelContext,
        scopeKey: string,
        view: ChannelCommandView
    ): Promise<{ providerMessageId?: string }>
    parseInboundAction?(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundAction | null
    // Fetch bounded prior platform history as a supplemental-context block for
    // this event's turn, or null when there is nothing to add. Must fail open —
    // the bridge swallows a null return or a thrown error and proceeds without
    // backfill. Providers that can recover attachments from history return
    // them alongside the text (see ChannelHistoryContext); text-only providers
    // return { text }.
    fetchHistoryContext?(
        ctx: ChannelContext,
        event: NormalizedInboundEvent,
        opts: { scopeKey: string; limit: number }
    ): Promise<ChannelHistoryContext | null>
    // Render the message this event replies to (event.replyToMessageId) as a
    // short labeled context line, or null when unavailable. Must fail open —
    // the bridge proceeds without the block on null or throw. The quoted body
    // is untrusted content and is kept outside the trusted context block.
    fetchReplyContext?(
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<string | null>
    // The short-lived credential an agent-managed reply needs to address this
    // event's peer itself (wechat: the iLink context_token). Read straight off
    // the event so it survives queue/replay, and only ever forwarded for a
    // channel that opted into agentManagedReply — the platform's own outbound
    // path reads its durable copy from provider state instead.
    replyCredential?(event: NormalizedInboundEvent): string | null
    // Resolve a display name for this event's external sender when the
    // platform payload lacks one. Called after the actor-policy gate (rejected
    // senders never pay the lookup) and before scope computation so session
    // names benefit. Must fail open (null / throw → proceed unnamed).
    resolveSenderName?(
        ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<string | null>
    // Reaction-as-status on the inbound message that triggered the turn:
    // 'working' when the turn starts, then 'done' or 'failed'. The provider
    // maps states to platform-native emoji (or clears the reaction where the
    // platform's emoji set has no fit). Must be cheap and safe to drop — the
    // bridge fires it without awaiting and swallows failures.
    setInboundReaction?(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string,
        state: 'working' | 'done' | 'failed'
    ): Promise<void>
    // Show a native "typing…" affordance until the returned stop fires; the
    // provider owns any re-fire timer the platform's decay requires. Platforms
    // without a typing API can anchor a reaction on the triggering message —
    // opts carries its provider message id (the scope key cannot encode it).
    startTyping?(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: {
            triggerProviderMessageId?: string | null
            chatSessionId?: string
        }
    ): Promise<() => void>
    // Mid-turn progress, for providers whose platform can show it as structured
    // entities rather than edited text. The bridge serializes these per turn and
    // fences the terminal reply behind them, so a projection can never land
    // after the reply it precedes. Failures are swallowed: progress is
    // best-effort and must never cost the reply. Called only when the channel's
    // progress mode is not 'final'; providers that omit it see no change.
    onTurnEvent?(
        ctx: ChannelContext,
        scopeKey: string,
        event: ChannelTurnTapEvent,
        info: { chatSessionId: string; channelSessionId: string }
    ): Promise<void>
    sendPreviewStart?(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: SendTextOptions
    ): Promise<PreviewHandle>
    updatePreview?(
        ctx: ChannelContext,
        handle: PreviewHandle,
        partial: string
    ): Promise<void>
    finishPreview?(
        ctx: ChannelContext,
        handle: PreviewHandle,
        finalText: string
    ): Promise<void>
    // Delete a previously-sent message (e.g. drop the streaming preview so the
    // final reply can be posted fresh and fire a push notification).
    deleteMessage?(
        ctx: ChannelContext,
        scopeKey: string,
        providerMessageId: string
    ): Promise<void>
    // Download an inbound attachment that needs provider-held credentials (e.g.
    // Slack url_private requires the bot token). When implemented, the bridge
    // uses this instead of the anonymous URL fetch. Must enforce opts.maxBytes
    // while reading and reject non-provider hosts. Auth is applied here, at
    // download time — the token is never carried on the event, so nothing
    // secret lands in event_json.
    downloadAttachment?(
        ctx: ChannelContext,
        attachment: NormalizedInboundAttachment,
        opts: { maxBytes: number }
    ): Promise<{ name: string; contentType: string; bytes: Buffer }>
    // Send agent-produced files/images to the channel as a follow-up message.
    sendAttachments?(
        ctx: ChannelContext,
        scopeKey: string,
        files: OutboundAttachment[]
    ): Promise<{ providerMessageId?: string }>
    test?(ctx: ChannelContext): Promise<ChannelTestResult>
    register?(
        ctx: ChannelContext,
        inboundUrl: string
    ): Promise<RegistrationResult>
    unregister?(ctx: ChannelContext): Promise<void>
}
