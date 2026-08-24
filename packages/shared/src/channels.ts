export type ChannelProviderName =
    | 'fake'
    | 'lark'
    | 'telegram'
    | 'slack'
    | 'discord'
    | 'matrix'
    | 'weixin'
    | 'linear'
    | 'github'
    | 'line'

export type ChannelStatus = 'draft' | 'active' | 'paused' | 'error'

export type ChannelDeliveryDirection = 'inbound' | 'outbound' | 'system'

export type ChannelDeliveryStatus =
    | 'pending'
    | 'queued'
    | 'processing'
    | 'accepted'
    | 'sent'
    | 'dropped'
    | 'failed'
    | 'dead'

export type ChannelProgressMode = 'preview' | 'activity' | 'final'

export type ChannelFinalMessageMode = 'edit' | 'fresh'

export type LarkAppRegion = 'feishu' | 'lark'

export type LarkAppRegistrationStatus =
    | 'pending'
    | 'creating'
    | 'succeeded'
    | 'failed'
    | 'expired'
    | 'cancelled'

export interface StartLarkRegistrationBody {
    agentId: string
    appRegion: LarkAppRegion
    label: string
    botName: string
}

export interface LarkAppRegistrationSummary {
    id: string
    agentId: string
    status: LarkAppRegistrationStatus
    qrUrl: string | null
    userCode: string
    intervalSec: number
    errorCode:
        | 'access_denied'
        | 'upstream_error'
        | 'channel_create_failed'
        | null
    errorMessage: string | null
    channelId: string | null
    expiresAt: string
    createdAt: string
    updatedAt: string
}

export type WeixinRegistrationStatus =
    | 'pending'
    | 'need_verify_code'
    | 'creating'
    | 'succeeded'
    | 'failed'
    | 'expired'
    | 'cancelled'

export interface StartWeixinRegistrationBody {
    agentId: string
    label: string
}

export interface SubmitWeixinVerifyCodeBody {
    verifyCode: string
}

export interface WeixinRegistrationSummary {
    id: string
    agentId: string
    status: WeixinRegistrationStatus
    // Scannable QR content (a URL); present only while pending/need_verify_code.
    qrcodeContent: string | null
    errorCode:
        | 'access_denied'
        | 'already_bound'
        | 'upstream_error'
        | 'channel_create_failed'
        | null
    errorMessage: string | null
    channelId: string | null
    expiresAt: string
    createdAt: string
    updatedAt: string
}

export type LarkSubscriptionMode = 'webhook' | 'websocket'

export type LarkRenderMode = 'auto' | 'text' | 'card'

export type LarkStreamingMode = 'patch' | 'cardkit'

export interface LarkChannelConfig {
    appId: string
    appRegion?: LarkAppRegion
    subscriptionMode: LarkSubscriptionMode
    verificationToken?: string | null
    encryptKey?: string | null
    mentionOnly: boolean
    shareSessionInChannel: boolean
    threadIsolation: boolean
    progressMode: ChannelProgressMode
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
    botName?: string | null
    // The bot's own open_id, captured by register() from bot/v3/info. Group
    // mention detection prefers it over the fragile botName display-name match.
    botOpenId?: string | null
    outboundFiles?: boolean
    renderMode?: LarkRenderMode
    // How streaming previews update: 'patch' replaces the whole interactive
    // card per flush; 'cardkit' uses the cardkit streaming API (typewriter).
    streaming?: LarkStreamingMode
    // Pull recent chat history into the turn when mentioned in a group.
    // On by default; requires the conversation-history read scope.
    historyBackfill?: boolean
    historyBackfillLimit?: number
    // Lark open_ids allowed to drive this agent. External actors, never
    // Manyfold identities. Empty = allow everyone in any chat the bot is in.
    allowedUserIds?: string[]
    // Lark open_ids allowed to run agent-wide commands (e.g. /model). Empty =
    // those commands are disabled from Lark (fail-closed).
    operatorUserIds?: string[]
}

export interface FakeChannelConfig {
    note?: string | null
    progressMode?: ChannelProgressMode
    finalMessageMode?: ChannelFinalMessageMode
    replyHud?: boolean
    outboundFiles?: boolean
    historyBackfill?: boolean
    historyBackfillLimit?: number
    contextProjection?: boolean
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface TelegramChannelConfig {
    botUsername?: string | null
    allowedUserIds?: string[]
    operatorUserIds?: string[]
    allowedChatIds?: string[]
    mentionOnly: boolean
    shareSessionInChannel: boolean
    threadIsolation: boolean
    progressMode: ChannelProgressMode
    // 'fresh' deletes the streaming preview and posts the final reply as a
    // new message so Telegram fires a push notification (edits never notify).
    finalMessageMode?: ChannelFinalMessageMode
    replyHud?: boolean
    // Attach files the agent links in its reply (from the workspace) to the
    // outbound message. On by default; set false to disable.
    outboundFiles?: boolean
    // React to the triggering message with 👀 while the agent works (cleared
    // when the turn ends). Off by default; typing status is always shown.
    ackReaction?: boolean
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface SlackChannelConfig {
    botUserId?: string | null
    teamId?: string | null
    // Slack user IDs allowed to drive this agent. External actors, never
    // Manyfold identities. Empty = allow everyone in any channel the bot is in.
    allowedUserIds: string[]
    // Slack user IDs allowed to run agent-wide commands (e.g. /model). Empty =
    // those commands are disabled from Slack (fail-closed).
    operatorUserIds: string[]
    mentionOnly: boolean
    shareSessionInChannel: boolean
    threadIsolation: boolean
    // When mentioned on a top-level channel message (not already in a thread),
    // reply in a thread rooted at that message. Requires threadIsolation.
    // Off by default.
    autoThread?: boolean
    progressMode: ChannelProgressMode
    // Attach files the agent links in its reply (from the workspace) to the
    // outbound message. On by default; set false to disable.
    outboundFiles?: boolean
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface DiscordChannelConfig {
    botUserId?: string | null
    botName?: string | null
    applicationId?: string | null
    allowedGuildIds: string[]
    mentionOnly: boolean
    shareSessionInChannel: boolean
    threadIsolation: boolean
    autoThread: boolean
    progressMode: ChannelProgressMode
    // 'fresh' deletes the streaming preview and posts the final reply as a new
    // message so Discord fires a push notification; 'edit' (default) edits the
    // preview in place.
    finalMessageMode: ChannelFinalMessageMode
    // Append a one-line usage footer (model · tokens · cost · duration · tools)
    // to each reply. Off by default.
    replyHud?: boolean
    // Attach files the agent links in its reply (from the workspace) to the
    // outbound message. On by default; set false to disable.
    outboundFiles?: boolean
    // When the agent is mentioned in a guild channel/thread, prepend recent
    // channel history (fetched via REST at turn start) to the user message so
    // it sees discussion that mention gating dropped. On by default;
    // historyBackfillLimit caps the single REST page (1-100, default 50).
    historyBackfill?: boolean
    historyBackfillLimit?: number
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface MatrixChannelConfig {
    homeserver: string
    botUserId?: string | null
    botDisplayName?: string | null
    allowedRoomIds: string[]
    allowedUserIds: string[]
    operatorUserIds?: string[]
    freeResponseRoomIds: string[]
    autoJoin: boolean
    mentionOnly: boolean
    processNotices?: boolean
    shareSessionInChannel: boolean
    threadIsolation: boolean
    autoThread: boolean
    progressMode: ChannelProgressMode
    outboundFiles?: boolean
    historyBackfill?: boolean
    historyBackfillLimit?: number
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface WeixinChannelConfig {
    // iLink bot identity (e.g. 05f361823d77@im.bot), informational; captured
    // at QR login. Personal WeChat via the Tencent iLink bot gateway is
    // DM-only: the bot cannot join group chats, so there are no group toggles.
    botId?: string | null
    // iLink user ids (e.g. wxid_xxx@im.wechat) allowed to drive this agent.
    // External actors, never Manyfold identities. Empty = allow anyone who
    // messages the bot.
    allowedUserIds: string[]
    // iLink user ids allowed to run agent-wide commands (e.g. /model). Empty =
    // those commands are disabled from Weixin (fail-closed).
    operatorUserIds: string[]
    progressMode: ChannelProgressMode
    outboundFiles?: boolean
    contextProjection?: boolean
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface LinearChannelConfig {
    // App user identity in the installed workspace (GraphQL viewer.id), the
    // workspace id and its url key. All three are captured by register() and
    // are what bind this channel to one Linear workspace.
    appUserId?: string | null
    organizationId?: string | null
    workspaceUrlKey?: string | null
    // Linear user ids allowed to drive this agent: the session creator on a
    // created event, the prompt's author on a prompted event. External
    // actors, never Manyfold identities. Empty = anyone in the workspace who
    // can reach the app user.
    allowedUserIds: string[]
    // 'activity' projects thinking, tool calls and the plan as agent
    // activities; 'final' emits only the terminal activity. Linear has no
    // message-edit API, so 'preview' is meaningless and normalizes to
    // 'activity'.
    progressMode: ChannelProgressMode
    contextProjection?: boolean
    agentManagedReply?: boolean
}

export interface GithubChannelConfig {
    // App identity captured by register(): the slug is the @mention handle,
    // botLogin ('{slug}[bot]') is the self-event guard, appHtmlUrl links the
    // app's settings/install pages.
    appSlug?: string | null
    botLogin?: string | null
    appHtmlUrl?: string | null
    // Repositories (owner/repo, case-insensitive) this channel reacts to.
    // Empty = every repository the app is installed on.
    allowedRepos: string[]
    // GitHub logins allowed to drive this agent. External actors, never
    // Manyfold identities. Empty = the association gate below decides alone.
    allowedUserIds: string[]
    // GitHub logins allowed to run agent-wide commands (e.g. /model). Empty =
    // those commands are disabled from GitHub (fail-closed).
    operatorUserIds: string[]
    // author_association values allowed to drive the agent. Anyone can
    // comment on a public repository, so this defaults closed to
    // OWNER/MEMBER/COLLABORATOR; add NONE to open it up to everyone.
    allowedAssociations: string[]
    // Adding this label to an issue delegates it to the agent without a
    // mention. Null = label delegation off.
    triggerLabel?: string | null
    progressMode: ChannelProgressMode
    // 'fresh' deletes the streaming preview and posts the final reply as a
    // new comment so watchers get a notification (GitHub never notifies on
    // comment edits).
    finalMessageMode?: ChannelFinalMessageMode
    // Pull the issue title, body and recent comments into the turn as
    // context. On by default.
    historyBackfill?: boolean
    historyBackfillLimit?: number
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export interface LineChannelConfig {
    // Bot identity captured by register() from GET /v2/bot/info. botUserId is
    // what mention.mentionees[].isSelf already resolves for us, so it is only
    // ever shown to the operator; basicId is the @-handle users search for.
    botUserId?: string | null
    basicId?: string | null
    botDisplayName?: string | null
    // LINE user ids (U…) allowed to drive this agent. External actors, never
    // Manyfold identities. Empty = anyone who can reach the bot.
    allowedUserIds: string[]
    // LINE user ids allowed to run agent-wide commands (e.g. /model). Empty =
    // those commands are disabled from LINE (fail-closed).
    operatorUserIds: string[]
    // Group (C…) and multi-person room (R…) ids this channel reacts to.
    // Empty = every group the bot was invited to.
    allowedChatIds: string[]
    mentionOnly: boolean
    shareSessionInChannel: boolean
    // LINE has no message-edit API, so 'preview' is meaningless and every
    // value normalizes to 'final'.
    progressMode: ChannelProgressMode
    // Prepend the [Channel message context] metadata block to each
    // channel-driven turn. On by default; set false to disable.
    contextProjection?: boolean
    // Agent-managed reply: forward structured source context and let the
    // agent deliver via its own channel tools (narranexus only). Off by default.
    agentManagedReply?: boolean
    resetOnIdleMins?: number | null
}

export type ChannelConfig =
    | LarkChannelConfig
    | FakeChannelConfig
    | TelegramChannelConfig
    | SlackChannelConfig
    | DiscordChannelConfig
    | MatrixChannelConfig
    | WeixinChannelConfig
    | LinearChannelConfig
    | GithubChannelConfig
    | LineChannelConfig

export interface LarkChannelCredentials {
    appSecret: string
}

export interface FakeChannelCredentials {
    secret?: string | null
}

export interface TelegramChannelCredentials {
    botToken: string
    webhookSecret?: string | null
}

export interface SlackChannelCredentials {
    botToken: string
    signingSecret: string
}

export interface DiscordChannelCredentials {
    botToken: string
}

export interface MatrixChannelCredentials {
    accessToken: string
}

export interface WeixinChannelCredentials {
    botToken: string
    // iLink gateway base URL bound to this token at QR login (the confirm
    // response may point at an IDC-specific host). Null = default gateway.
    baseUrl?: string | null
}

export interface LinearChannelCredentials {
    // OAuth application client pair, used to mint an app actor token via the
    // client_credentials grant. Optional when accessToken is supplied instead.
    clientId?: string | null
    clientSecret?: string | null
    // Webhook signing secret from the Linear application settings. Always
    // required: inbound verification is independent of the token strategy.
    webhookSecret: string
    // Pre-minted app actor token. When present it is used verbatim and no
    // minting happens, so a 401 is permanent rather than a re-mint trigger.
    accessToken?: string | null
}

export interface GithubChannelCredentials {
    // GitHub App id (numeric, kept as a string) — the JWT issuer.
    appId: string
    // App private key: PEM, or base64-encoded PEM (secret-store friendly).
    privateKey: string
    // Webhook secret configured on the app; signs every delivery.
    webhookSecret: string
}

export interface LineChannelCredentials {
    // Channel secret from the LINE Developers console; signs every webhook.
    channelSecret: string
    // Long-lived channel access token; the bearer for every Messaging API call.
    channelAccessToken: string
}

export type ChannelCredentials =
    | LarkChannelCredentials
    | FakeChannelCredentials
    | TelegramChannelCredentials
    | SlackChannelCredentials
    | DiscordChannelCredentials
    | MatrixChannelCredentials
    | WeixinChannelCredentials
    | LinearChannelCredentials
    | GithubChannelCredentials
    | LineChannelCredentials

export interface ChannelAgentSummary {
    id: string
    name: string
}

export interface ChannelSummary {
    id: string
    userId: string
    agentId: string
    agent: ChannelAgentSummary
    provider: ChannelProviderName
    label: string
    status: ChannelStatus
    config: ChannelConfig
    // True when the row mirrors an external framework binding (a NarraNexus
    // channel credential) and is read-only in Manyfold surfaces.
    managed: boolean
    inboundUrl: string
    lastConnectedAt: string | null
    lastErrorAt: string | null
    lastErrorMessage: string | null
    createdAt: string
    updatedAt: string
}

export interface ChannelDeliverySummary {
    id: string
    channelId: string
    chatSessionId: string | null
    chatMessageId: string | null
    direction: ChannelDeliveryDirection
    scopeKey: string
    providerEventId: string | null
    providerMessageId: string | null
    summaryText: string | null
    status: ChannelDeliveryStatus
    errorMessage: string | null
    createdAt: string
}

export interface ChannelDetail extends ChannelSummary {
    recentDeliveries: ChannelDeliverySummary[]
}

export interface CreateChannelBody {
    agentId: string
    provider: ChannelProviderName
    label: string
    config: ChannelConfig
    credentials?: ChannelCredentials | null
}

export interface UpdateChannelBody {
    // Rebinding to another agent archives every non-archived channel session
    // (each chat scope starts a fresh session under the new agent) and turns
    // off delivery on automations of other agents that used this channel.
    agentId?: string
    label?: string
    status?: ChannelStatus
    config?: ChannelConfig
    credentials?: ChannelCredentials | null
}

export interface ChannelTestResult {
    ok: boolean
    message: string
}

// GET /channels/:id/github-app-manifest — everything the web app needs to
// submit GitHub's create-app-from-manifest form: the github.com POST target
// (personal or organization variant, signed state already in its query) and
// the manifest JSON for the form's `manifest` field.
export interface GithubAppManifestResponse {
    postUrl: string
    manifest: Record<string, unknown>
}

export interface ChannelSessionSummary {
    channelSessionId: string
    chatSessionId: string
    scopeKey: string
    scopeName: string | null
    displayName: string | null
    chatTitle: string | null
    isActive: boolean
    archivedAt: string | null
    lastInboundAt: string | null
    lastOutboundAt: string | null
    createdAt: string
    updatedAt: string
}

export interface ChannelScopeSummary {
    scopeKey: string
    scopeName: string | null
    activeSession: ChannelSessionSummary | null
    sessionCount: number
    lastActivityAt: string | null
}

export type ChannelScopeKind =
    | 'dm'
    | 'channel'
    | 'thread'
    | 'channel-user'
    | 'conversation'

export interface ChannelScopeDescriptor {
    kind: ChannelScopeKind
    channelId: string | null
    threadId: string | null
    userId: string | null
}

const UNKNOWN_SCOPE: ChannelScopeDescriptor = {
    kind: 'conversation',
    channelId: null,
    threadId: null,
    userId: null
}

// Best-effort parse of persisted session scope keys into UI-labelable parts.
// Scope key formats are a compat contract (they live in channel_sessions
// rows), so this stays in lockstep with the providers' computeScopeKey.
// Unrecognized providers or shapes fall back to a generic conversation.
export const describeChannelScope = (
    provider: string,
    scopeKey: string
): ChannelScopeDescriptor => {
    const segments = scopeKey.split(':')
    if (provider === 'discord' && segments[0] === 'discord') {
        if (segments[1] === 'dm' && segments[2] === 'user' && segments[3])
            return {
                kind: 'dm',
                channelId: null,
                threadId: null,
                userId: segments[3]
            }
        if (
            segments[1] === 'guild' &&
            segments[3] === 'channel' &&
            segments[4]
        ) {
            const channelId = segments[4]
            if (segments[5] === 'thread' && segments[6])
                return {
                    kind: 'thread',
                    channelId,
                    threadId: segments[6],
                    userId: null
                }
            if (segments[5] === 'user' && segments[6])
                return {
                    kind: 'channel-user',
                    channelId,
                    threadId: null,
                    userId: segments[6]
                }
            if (segments.length === 5)
                return {
                    kind: 'channel',
                    channelId,
                    threadId: null,
                    userId: null
                }
        }
        return UNKNOWN_SCOPE
    }
    if (provider === 'slack' && segments[0] === 'slack') {
        const channelId = segments[2]
        if (!channelId) return UNKNOWN_SCOPE
        const marker = segments.indexOf('thread', 3)
        const threadId =
            marker !== -1 && segments[marker + 1] ? segments[marker + 1] : null
        const userId = marker !== 3 && segments[3] ? segments[3] : null
        // Slack DM conversation ids start with D; per-user channel scopes
        // share the same segment shape and differ only by that prefix.
        const isDm = channelId.startsWith('D')
        if (threadId)
            return {
                kind: isDm ? 'dm' : 'thread',
                channelId,
                threadId,
                userId
            }
        if (userId && isDm)
            return { kind: 'dm', channelId, threadId: null, userId }
        if (userId)
            return { kind: 'channel-user', channelId, threadId: null, userId }
        return { kind: 'channel', channelId, threadId: null, userId: null }
    }
    if (provider === 'line' && segments[0] === 'line') {
        const chatId = segments[1]
        if (!chatId) return UNKNOWN_SCOPE
        const userId = segments[2] ?? null
        // LINE ids are prefixed by source kind: U = user (so the chat is a
        // 1:1), C = group, R = multi-person room.
        const isDm = chatId.startsWith('U')
        if (isDm) return { kind: 'dm', channelId: chatId, threadId: null, userId }
        if (userId)
            return {
                kind: 'channel-user',
                channelId: chatId,
                threadId: null,
                userId
            }
        return { kind: 'channel', channelId: chatId, threadId: null, userId: null }
    }
    // linear:{organizationId}:{agentSessionId} needs no branch: an agent
    // session is one conversation and its id is neither a channel nor a thread
    // id, so the generic fallback is already the honest descriptor. The same
    // holds for github:{owner/repo}:{issueNumber} — an issue is one
    // conversation, not a channel or a thread.
    return UNKNOWN_SCOPE
}

export interface CreateChannelSessionBody {
    displayName?: string | null
}

export interface UpdateChannelSessionBody {
    displayName?: string | null
    makeActive?: boolean
}

export interface AgentChannelSendBody {
    // At least one of text / files is required.
    text?: string
    // Workspace-relative file paths to attach (max 4). Read server-side from
    // the agent's workspace at send time; delivered as a separate message so
    // text and files retry independently.
    files?: string[]
    chatId?: string
    userId?: string
    replyToMessageId?: string
}

// Providers whose ChannelProvider class implements sendDirect (agent- and
// automation-initiated sends to an explicit target). Hand-maintained next to
// the provider implementations; the bridge re-checks the real capability at
// send time, so drift here only mis-filters UI pickers and create-time
// validation, never sends.
export const AGENT_SEND_PROVIDERS: readonly ChannelProviderName[] = [
    'lark',
    'telegram',
    'weixin',
    'matrix',
    'line',
    'fake'
]

export interface AgentChannelSendResult {
    deliveryId: string
    // 'queued' = send failed but will be retried; 'failed' = the platform
    // rejected it permanently (blocked, target gone) and no retry will run.
    status: 'sent' | 'queued' | 'failed'
    providerMessageId?: string | null
    // Present when the send carried BOTH text and files: the file delivery's
    // own outcome (files-only sends report through the top-level fields).
    files?: {
        deliveryId: string
        status: 'sent' | 'queued' | 'failed'
        providerMessageId?: string | null
    }
}
