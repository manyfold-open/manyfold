import type {
    ChannelProgressMode,
    ChannelTestResult,
    LinearChannelConfig,
    LinearChannelCredentials
} from '@manyfold/shared'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { configString } from '@/common/config-alias'
import {
    UnsupportedEventError,
    type ChannelContext,
    type ChannelHistoryContext,
    type ChannelHandle,
    type ChannelProvider,
    type ChannelTurnTapEvent,
    type InboundActorPolicy,
    type InboundRequest,
    type NormalizedInboundEvent,
    type RegistrationResult,
    type SendTextOptions,
    type SignatureCheck
} from '../channel-provider'
import { channelProviderJsonRequest } from './channel-http'
import { ChannelSendError } from '../channel-send-error'
import { chunkText } from '../text-chunk'

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token'
// Fixed forever: requesting client-credentials tokens with a different scope
// set revokes every existing app actor token for the application.
const LINEAR_TOKEN_SCOPE = 'read,write,app:assignable,app:mentionable'
const LINEAR_SIGNATURE_HEADER = 'linear-signature'
// Linear recommends rejecting payloads older than a minute (replay guard).
const LINEAR_REPLAY_WINDOW_MS = 60_000
// Read a cached token as expired this far ahead of its real expiry, and shave
// the same amount off on write, so an in-flight call cannot straddle expiry.
const LINEAR_TOKEN_SKEW_MS = 60_000
// Linear marks a session stale after 30 minutes without an activity; a
// heartbeat well inside that keeps a long turn alive (stale is recoverable,
// but the UI shows it).
const LINEAR_HEARTBEAT_INTERVAL_MS = 20 * 60_000
// No documented cap on activity body length; stay conservative and chunk.
const LINEAR_ACTIVITY_MAX_BODY = 7_000
const LINEAR_RATE_LIMIT_RETRY_MS = 60_000
// Each projection is a mutation, and the workspace's whole request budget is
// shared across every session of the app user, so pace them.
const LINEAR_THOUGHT_MIN_INTERVAL_MS = 5_000
const LINEAR_ACTION_MIN_GAP_MS = 1_000
// Consecutive projection failures before progress is dropped for the rest of
// the turn (preview-strike precedent): keep the reply, stop the churn.
const LINEAR_TAP_STRIKE_LIMIT = 3
const LINEAR_ACTION_PARAMETER_MAX = 200
// Ceiling on the per-session memo sets (external URL added, issue claimed).
// Evicting the oldest only costs an idempotent re-check on a long-cold
// session, so the cap can be generous; without one a long-lived process
// grows them forever.
const LINEAR_SESSION_MEMO_CAP = 4096

interface LinearUserPayload {
    id?: unknown
    name?: unknown
    displayName?: unknown
}

interface LinearIssuePayload {
    id?: unknown
    identifier?: unknown
    title?: unknown
}

interface LinearAgentSessionPayload {
    id?: unknown
    creator?: LinearUserPayload | null
    issue?: LinearIssuePayload | null
    comment?: { id?: unknown; body?: unknown } | null
}

interface LinearAgentActivityPayload {
    id?: unknown
    signal?: unknown
    content?: { type?: unknown; body?: unknown } | null
    // The author of this activity. On a prompted event this is the person who
    // wrote the follow-up, who need not be the session creator.
    user?: LinearUserPayload | null
    userId?: unknown
}

interface LinearWebhookBody {
    type?: unknown
    action?: unknown
    organizationId?: unknown
    appUserId?: unknown
    webhookTimestamp?: unknown
    agentSession?: LinearAgentSessionPayload | null
    agentActivity?: LinearAgentActivityPayload | null
    promptContext?: unknown
    previousComments?: unknown
    guidance?: unknown
}

type LinearActivityContent =
    | { type: 'thought'; body: string }
    | { type: 'response'; body: string }
    | { type: 'error'; body: string }
    | { type: 'action'; action: string; parameter: string; result?: string }

interface LinearTokenCacheEntry {
    token: string
    expiresAt: number
}

interface LinearPlanStep {
    content: string
    status: 'pending' | 'inProgress' | 'completed' | 'canceled'
}

interface LinearTapState {
    lastThoughtAt: number
    lastActionAt: number
    strikes: number
    disabled: boolean
    planDisabled: boolean
}

interface LinearIssueClaimQuery {
    agentSession?: {
        creator?: { id?: string } | null
        issue?: {
            id?: string
            delegate?: { id?: string } | null
            state?: { id?: string; type?: string } | null
            team?: { id?: string } | null
        } | null
    } | null
}

interface LinearStartedStatesQuery {
    team?: {
        states?: { nodes?: { id?: string; position?: number }[] } | null
    } | null
}

@Injectable()
export class LinearChannelProvider implements ChannelProvider {
    readonly name = 'linear' as const
    private readonly logger = new Logger(LinearChannelProvider.name)
    // Keyed by channel + client id so rotating the client pair or switching to
    // a manual token cannot serve a stale token (lark tokenCache precedent).
    private readonly tokenCache = new Map<string, LinearTokenCacheEntry>()
    // Per-scope progress throttles and failure budget, cleared on the terminal.
    private readonly tapState = new Map<string, LinearTapState>()
    // chatSessionIds whose session already carries the workbench link.
    // Insertion-capped (LINEAR_SESSION_MEMO_CAP).
    private readonly externalUrlAdded = new Set<string>()
    // agentSessionIds already checked for delegation, so a follow-up prompt does
    // not pay for the lookup again. Insertion-capped (LINEAR_SESSION_MEMO_CAP).
    private readonly issueClaimed = new Set<string>()
    // teamId -> first started state id (null when the team has none).
    private readonly startedStateByTeam = new Map<string, string | null>()
    private readonly webOrigin: string

    constructor(config: ConfigService) {
        this.webOrigin = (
            configString(config, [
                'MF_WEB_URL',
                'NCA_WEB_URL',
                'WEB_BASE_URL'
            ]) ?? 'https://manyfold.ai'
        ).replace(/\/+$/, '')
    }

    validateConfig(config: unknown): LinearChannelConfig {
        if (!config || typeof config !== 'object')
            throw new BadRequestException('config must be an object')
        const c = config as Record<string, unknown>
        return {
            appUserId: optionalString(c.appUserId),
            organizationId: optionalString(c.organizationId),
            workspaceUrlKey: optionalString(c.workspaceUrlKey),
            allowedUserIds: stringList(c.allowedUserIds),
            progressMode: parseLinearProgressMode(c.progressMode),
            contextProjection: c.contextProjection !== false,
            agentManagedReply: c.agentManagedReply === true
        }
    }

    validateCredentials(credentials: unknown): LinearChannelCredentials | null {
        if (credentials === null || credentials === undefined) return null
        if (typeof credentials !== 'object')
            throw new BadRequestException('credentials must be an object')
        const c = credentials as Record<string, unknown>
        const webhookSecret =
            typeof c.webhookSecret === 'string' ? c.webhookSecret.trim() : ''
        if (webhookSecret.length < 16)
            throw new BadRequestException(
                'credentials.webhookSecret is required (copy the signing secret from your Linear application)'
            )
        const clientId = optionalString(c.clientId)
        const clientSecret = optionalString(c.clientSecret)
        const accessToken = optionalString(c.accessToken)
        if (!accessToken && !(clientId && clientSecret))
            throw new BadRequestException(
                'credentials require either accessToken, or both clientId and clientSecret'
            )
        return { clientId, clientSecret, webhookSecret, accessToken }
    }

    async start(): Promise<ChannelHandle> {
        return { status: 'connected', stop: async () => {} }
    }

    verifySignature(req: InboundRequest, ctx: ChannelContext): SignatureCheck {
        const credentials = ctx.credentials as LinearChannelCredentials | null
        const secret = credentials?.webhookSecret
        if (!secret) return { ok: false, reason: 'webhook_secret_missing' }
        const headers = lowercaseHeaders(req.headers)
        const signature = headers[LINEAR_SIGNATURE_HEADER]
        if (!signature) return { ok: false, reason: 'missing_signature' }
        const rawBody =
            req.rawBody ??
            (typeof req.body === 'string'
                ? req.body
                : JSON.stringify(req.body ?? {}))
        const expected = createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex')
        const a = Buffer.from(expected)
        const b = Buffer.from(signature)
        if (a.length !== b.length || !timingSafeEqual(a, b))
            return { ok: false, reason: 'signature_mismatch' }
        const stamp = Number(
            (req.body as LinearWebhookBody | null)?.webhookTimestamp
        )
        if (!Number.isFinite(stamp))
            return { ok: false, reason: 'bad_timestamp' }
        if (Math.abs(Date.now() - stamp) > LINEAR_REPLAY_WINDOW_MS)
            return { ok: false, reason: 'timestamp_out_of_range' }
        // Linear has no url_verification handshake, so there is no challenge
        // response to return: the channel is activated by register() instead.
        return { ok: true }
    }

    parseInbound(
        req: InboundRequest,
        ctx: ChannelContext
    ): NormalizedInboundEvent {
        const body = (req.body ?? {}) as LinearWebhookBody
        const type = typeof body.type === 'string' ? body.type : 'unknown'
        if (type !== 'AgentSessionEvent')
            // Inbox notifications mirror events the session webhook already
            // carries, so they are pure noise; the rest are worth a row.
            throw new UnsupportedEventError(type, {
                silent: type === 'AppUserNotification'
            })
        const config = ctx.config as LinearChannelConfig
        const session = body.agentSession
        const sessionId = typeof session?.id === 'string' ? session.id : ''
        if (!sessionId) throw new BadRequestException('missing agentSession.id')
        const organizationId =
            typeof body.organizationId === 'string' ? body.organizationId : ''
        if (!organizationId)
            throw new BadRequestException('missing organizationId')
        const appUserId =
            typeof body.appUserId === 'string' ? body.appUserId : null
        const creatorId =
            typeof session?.creator?.id === 'string' ? session.creator.id : null
        const chatId = `${organizationId}:${sessionId}`
        const action = typeof body.action === 'string' ? body.action : 'unknown'
        const base = {
            chatId,
            chatType: 'group' as const,
            // Every agent session event is addressed to this app by
            // construction — Linear only delivers what mentions or delegates
            // to it, so there is no mention gate to apply.
            isMention: true,
            senderId:
                creatorId ?? appUserId ?? config.appUserId ?? 'linear-app',
            senderName: displayNameOf(session?.creator),
            threadId: null,
            raw: body
        }
        if (action === 'created') {
            // A mention carries the asker's words in the session's root comment
            // and Linear marks that thread as the primary directive. A pure
            // delegation has no directive comment, and the root comment Linear
            // auto-creates for it ("This thread is for an agent session with
            // <app>.") is boilerplate — handing that to the agent as its
            // instruction sends it off investigating its own name, so the
            // delegation is stated explicitly instead.
            const promptContext =
                typeof body.promptContext === 'string' ? body.promptContext : ''
            const directed = promptContext.includes('<primary-directive-thread')
            const comment =
                directed && typeof session?.comment?.body === 'string'
                    ? stripLeadingMention(session.comment.body).trim()
                    : ''
            const text =
                comment.length > 0
                    ? comment
                    : delegationDirective(session?.issue)
            return {
                ...base,
                providerEventId: `created:${sessionId}`,
                text,
                messageId:
                    typeof session?.comment?.id === 'string'
                        ? session.comment.id
                        : null
            }
        }
        if (action === 'prompted') {
            const activity = body.agentActivity
            const activityId =
                typeof activity?.id === 'string' ? activity.id : ''
            if (!activityId)
                throw new BadRequestException('missing agentActivity.id')
            // The actor of a prompted event is the activity's author, not the
            // session creator: anyone able to comment on the issue can write
            // into the session thread, so the allowlist must gate the person
            // who wrote this prompt.
            const prompterId =
                typeof activity?.user?.id === 'string'
                    ? activity.user.id
                    : typeof activity?.userId === 'string'
                      ? activity.userId
                      : null
            const prompted = {
                ...base,
                senderId: prompterId ?? base.senderId,
                senderName: displayNameOf(activity?.user) ?? base.senderName
            }
            if (activity?.signal === 'stop')
                // Reuse the existing /stop command: it cancels the in-flight
                // turn and discards the queue, which is exactly the contract
                // Linear's stop signal asks for.
                return {
                    ...prompted,
                    providerEventId: `prompted:${activityId}`,
                    text: '/stop',
                    commandInvocation: true,
                    messageId: activityId
                }
            const text =
                typeof activity?.content?.body === 'string'
                    ? activity.content.body.trim()
                    : ''
            if (text.length === 0)
                throw new UnsupportedEventError('empty_prompt')
            return {
                ...prompted,
                providerEventId: `prompted:${activityId}`,
                text,
                messageId: activityId
            }
        }
        throw new UnsupportedEventError(`action:${action}`)
    }

    computeScopeKey(event: NormalizedInboundEvent): {
        scopeKey: string
        scopeName: string | null
    } {
        const raw = event.raw as LinearWebhookBody | null
        const issue = raw?.agentSession?.issue
        const identifier =
            typeof issue?.identifier === 'string' ? issue.identifier : null
        const title = typeof issue?.title === 'string' ? issue.title : null
        const scopeName = identifier
            ? title
                ? `${identifier} ${title}`
                : identifier
            : null
        return { scopeKey: `linear:${event.chatId}`, scopeName }
    }

    evaluateInboundActor(
        event: NormalizedInboundEvent,
        config: ChannelConfigLike
    ): InboundActorPolicy {
        const linear = config as LinearChannelConfig
        const organizationId = event.chatId.split(':')[0]
        if (linear.organizationId && organizationId !== linear.organizationId)
            return { allowed: false, reason: 'org_mismatch', operator: false }
        const raw = event.raw as LinearWebhookBody | null
        const appUserId =
            typeof raw?.appUserId === 'string' ? raw.appUserId : null
        if (linear.appUserId && appUserId && appUserId !== linear.appUserId)
            return {
                allowed: false,
                reason: 'app_user_mismatch',
                operator: false
            }
        const allowed = linear.allowedUserIds ?? []
        // A session created by automation has no human creator, so senderId
        // fell back to the app user itself — that is the app acting, not an
        // unlisted human, and must not be gated by the allowlist.
        const isSelf = appUserId !== null && event.senderId === appUserId
        if (allowed.length > 0 && !isSelf && !allowed.includes(event.senderId))
            return {
                allowed: false,
                reason: 'sender_not_allowed',
                operator: false
            }
        // Agent-wide commands (e.g. /model, which changes every session's
        // model) stay disabled from Linear: there is no operator concept to
        // authorize them against, so fail closed.
        return { allowed: true, operator: false }
    }

    async fetchHistoryContext(
        _ctx: ChannelContext,
        event: NormalizedInboundEvent
    ): Promise<ChannelHistoryContext | null> {
        const raw = event.raw as LinearWebhookBody | null
        if (raw?.action !== 'created') return null
        const promptContext =
            typeof raw.promptContext === 'string'
                ? raw.promptContext.trim()
                : ''
        if (promptContext.length === 0) return null
        return { text: `[Linear issue context]\n${promptContext}` }
    }

    async startTyping(
        ctx: ChannelContext,
        scopeKey: string,
        opts?: { chatSessionId?: string }
    ): Promise<() => void> {
        const sessionId = this.sessionIdFromScopeKey(scopeKey)
        // Linear also treats a session with an external URL as responsive, so
        // this doubles as insurance on the acknowledgement window.
        void this.maybeAddExternalUrl(ctx, sessionId, opts?.chatSessionId)
        // Linear shows a session as unresponsive unless an activity lands
        // within 10 seconds of the created event, so this ack is not cosmetic.
        await this.createActivity(
            ctx,
            sessionId,
            { type: 'thought', body: 'Working on it…' },
            { ephemeral: true }
        )
        // Deliberately not awaited: claiming the issue costs two more round
        // trips and the acknowledgement above is the one on a deadline.
        void this.claimDelegatedIssue(ctx, sessionId)
        let warned = false
        const interval = setInterval(() => {
            void this.createActivity(
                ctx,
                sessionId,
                { type: 'thought', body: 'Still working…' },
                { ephemeral: true }
            ).catch((err) => {
                if (warned) return
                warned = true
                this.logger.warn(
                    `linear heartbeat failed channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            })
        }, LINEAR_HEARTBEAT_INTERVAL_MS)
        interval.unref?.()
        return () => clearInterval(interval)
    }

    async onTurnEvent(
        ctx: ChannelContext,
        scopeKey: string,
        event: ChannelTurnTapEvent,
        info: { chatSessionId: string }
    ): Promise<void> {
        const state = this.tapStateFor(scopeKey)
        if (state.disabled) return
        // A tool result cannot be attached to the action already sent (no edit
        // API) and standing alone it reads as noise, so it is deliberately
        // dropped. The hook still receives it so this can change without
        // another bridge change.
        if (event.type === 'tool_result') return
        const sessionId = this.sessionIdFromScopeKey(scopeKey)
        try {
            if (event.type === 'thinking') {
                const now = Date.now()
                if (now - state.lastThoughtAt < LINEAR_THOUGHT_MIN_INTERVAL_MS)
                    return
                state.lastThoughtAt = now
                const body = event.text.trim()
                if (body.length === 0) return
                await this.createActivity(
                    ctx,
                    sessionId,
                    { type: 'thought', body: truncate(body, 800) },
                    { ephemeral: true }
                )
            } else if (isPlanTool(event.toolName)) {
                await this.updatePlan(ctx, sessionId, state, event.args)
            } else {
                const gap = Date.now() - state.lastActionAt
                if (gap < LINEAR_ACTION_MIN_GAP_MS)
                    await sleep(LINEAR_ACTION_MIN_GAP_MS - gap)
                state.lastActionAt = Date.now()
                await this.createActivity(ctx, sessionId, {
                    type: 'action',
                    action: event.toolName,
                    parameter: summarizeArgs(event.args)
                })
            }
            state.strikes = 0
            void this.maybeAddExternalUrl(ctx, sessionId, info.chatSessionId)
        } catch (err) {
            state.strikes += 1
            if (state.strikes >= LINEAR_TAP_STRIKE_LIMIT) {
                state.disabled = true
                this.logger.warn(
                    `linear progress disabled for the rest of the turn channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            }
            throw err
        }
    }

    async sendText(
        ctx: ChannelContext,
        scopeKey: string,
        text: string,
        opts?: SendTextOptions
    ): Promise<{ providerMessageId?: string }> {
        const sessionId = this.sessionIdFromScopeKey(scopeKey)
        const type = this.activityTypeFor(opts)
        if (opts?.terminal) this.tapState.delete(scopeKey)
        let lastId: string | undefined
        for (const chunk of chunkText(text, LINEAR_ACTIVITY_MAX_BODY)) {
            lastId = await this.createActivity(ctx, sessionId, {
                type,
                body: chunk
            })
        }
        return { providerMessageId: lastId }
    }

    async test(ctx: ChannelContext): Promise<ChannelTestResult> {
        const credentials = ctx.credentials as LinearChannelCredentials | null
        if (!credentials?.webhookSecret)
            return { ok: false, message: '✗ webhookSecret missing' }
        const lines: string[] = []
        let ok = true
        try {
            const viewer = await this.fetchIdentity(ctx)
            lines.push(
                `✓ authenticated as ${viewer.name} in ${viewer.organizationName}`
            )
        } catch (err) {
            return {
                ok: false,
                message: `✗ Linear authentication failed: ${(err as Error).message}`
            }
        }
        if (ctx.channel.status === 'draft') {
            ok = false
            lines.push(
                '✗ channel is still draft — run Register to activate it, then point your Linear application webhook at the inbound URL with Agent session events enabled'
            )
        } else if (ctx.channel.status === 'error') {
            ok = false
            lines.push(
                `✗ channel status is error — ${ctx.channel.lastErrorMessage ?? 'unknown error'}`
            )
        } else {
            lines.push(`✓ channel status: ${ctx.channel.status}`)
        }
        return { ok, message: lines.join('\n') }
    }

    async register(ctx: ChannelContext): Promise<RegistrationResult> {
        const credentials = ctx.credentials as LinearChannelCredentials | null
        if (
            !credentials?.accessToken &&
            !(credentials?.clientId && credentials?.clientSecret)
        )
            return {
                ok: false,
                message:
                    'linear credentials require either accessToken, or both clientId and clientSecret'
            }
        // Force a mint so registering proves the client pair actually yields an
        // app actor token rather than trusting a cached one.
        const identity = await this.fetchIdentity(ctx, { forceToken: true })
        const config = ctx.config as LinearChannelConfig
        return {
            ok: true,
            activate: true,
            configPatch: {
                ...config,
                appUserId: identity.id,
                organizationId: identity.organizationId,
                workspaceUrlKey: identity.organizationUrlKey
            },
            message: `authenticated as ${identity.name} in ${identity.organizationName}`
        }
    }

    private activityTypeFor(
        opts?: SendTextOptions
    ): 'thought' | 'response' | 'error' {
        if (opts?.terminal === 'error') return 'error'
        // A cancelled turn still ends the exchange: Linear expects a response
        // (or error) activity to confirm the agent stopped.
        if (opts?.terminal) return 'response'
        // The only Linear inbound that is a native command invocation is the
        // stop signal, so a housekeeping send that answers an invocation
        // (interactionRef) is the stop confirmation Linear's contract asks
        // for. Any other housekeeping send must stay a thought or it would
        // wrongly conclude the session.
        if (opts?.nonConversational)
            return opts.interactionRef ? 'response' : 'thought'
        // Opts-less sends (agent-scoped automation delivery, legacy swept rows)
        // are the agent's own words; response keeps the session complete.
        return 'response'
    }

    private tapStateFor(scopeKey: string): LinearTapState {
        const existing = this.tapState.get(scopeKey)
        if (existing) return existing
        const fresh: LinearTapState = {
            lastThoughtAt: 0,
            lastActionAt: 0,
            strikes: 0,
            disabled: false,
            planDisabled: false
        }
        this.tapState.set(scopeKey, fresh)
        return fresh
    }

    private async updatePlan(
        ctx: ChannelContext,
        agentSessionId: string,
        state: LinearTapState,
        args: unknown
    ): Promise<void> {
        if (state.planDisabled) return
        const plan = parsePlanSteps(args)
        if (plan.length === 0) return
        try {
            await this.gql(
                ctx,
                'agentSessionUpdate',
                `mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
                    agentSessionUpdate(id: $id, input: $input) { success }
                }`,
                { id: agentSessionId, input: { plan } }
            )
        } catch (err) {
            // Verified against the live API: the input is a bare array of steps
            // (an object wrapper and an empty array are both rejected as
            // "Invalid plan"; only null clears a plan), while reads return
            // { entries, updatedAt } — which is why the schema types the field
            // as JSONObject. The API is still a technology preview, so a shape
            // it rejects must cost the plan only, never the turn's other
            // progress or its reply.
            if (err instanceof ChannelSendError && err.kind === 'bad_format') {
                state.planDisabled = true
                this.logger.warn(
                    `linear rejected the session plan, dropping it for this session channel=${ctx.channel.id}: ${err.message}`
                )
                return
            }
            throw err
        }
    }

    private async maybeAddExternalUrl(
        ctx: ChannelContext,
        agentSessionId: string,
        chatSessionId: string | undefined
    ): Promise<void> {
        if (!chatSessionId || this.externalUrlAdded.has(chatSessionId)) return
        rememberCapped(
            this.externalUrlAdded,
            chatSessionId,
            LINEAR_SESSION_MEMO_CAP
        )
        const url = `${this.webOrigin}/agents/${ctx.channel.agentId}/chat?sessionId=${chatSessionId}`
        try {
            await this.gql(
                ctx,
                'agentSessionUpdate',
                `mutation AgentSessionAddUrl($id: String!, $input: AgentSessionUpdateInput!) {
                    agentSessionUpdate(id: $id, input: $input) { success }
                }`,
                {
                    id: agentSessionId,
                    // Never externalLink: writing it replaces the whole array.
                    input: {
                        addedExternalUrls: [{ label: 'Manyfold', url }]
                    }
                }
            )
        } catch (err) {
            this.externalUrlAdded.delete(chatSessionId)
            this.logger.debug(
                `linear external url add failed channel=${ctx.channel.id}: ${(err as Error).message}`
            )
        }
    }

    // Take visible ownership of a delegated issue the way Linear asks agents to:
    // become the delegate when nobody holds it, and move a not-yet-started issue
    // into work. Best-effort throughout — a workspace that rejects either write
    // still gets the turn and its reply.
    private async claimDelegatedIssue(
        ctx: ChannelContext,
        agentSessionId: string
    ): Promise<void> {
        if (this.issueClaimed.has(agentSessionId)) return
        rememberCapped(
            this.issueClaimed,
            agentSessionId,
            LINEAR_SESSION_MEMO_CAP
        )
        const config = ctx.config as LinearChannelConfig
        const appUserId = config.appUserId
        if (!appUserId) return
        try {
            const session = await this.gql<LinearIssueClaimQuery>(
                ctx,
                'agentSession',
                `query AgentSessionIssue($id: String!) {
                    agentSession(id: $id) {
                        creator { id }
                        issue {
                            id
                            delegate { id }
                            state { id type }
                            team { id }
                        }
                    }
                }`,
                { id: agentSessionId }
            )
            const issue = session.agentSession?.issue
            if (!issue?.id) return
            // An automation-created session has no human creator. Linear's
            // guidance is to leave those in triage so a person decides who
            // picks the work up, so neither write applies.
            if (!session.agentSession?.creator?.id) return
            if (!issue.delegate?.id)
                await this.updateIssue(ctx, issue.id, { delegateId: appUserId })
            const stateType = issue.state?.type
            if (
                stateType === 'started' ||
                stateType === 'completed' ||
                stateType === 'canceled'
            )
                return
            const teamId = issue.team?.id
            if (!teamId) return
            const startedStateId = await this.firstStartedStateId(ctx, teamId)
            if (!startedStateId) return
            await this.updateIssue(ctx, issue.id, { stateId: startedStateId })
        } catch (err) {
            this.logger.debug(
                `linear issue claim failed channel=${ctx.channel.id}: ${(err as Error).message}`
            )
        }
    }

    private async updateIssue(
        ctx: ChannelContext,
        issueId: string,
        input: Record<string, string>
    ): Promise<void> {
        await this.gql(
            ctx,
            'issueUpdate',
            `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
                issueUpdate(id: $id, input: $input) { success }
            }`,
            { id: issueId, input }
        )
    }

    // The team's earliest started status, which is what Linear's guidance means
    // by moving an issue into work.
    private async firstStartedStateId(
        ctx: ChannelContext,
        teamId: string
    ): Promise<string | null> {
        const cached = this.startedStateByTeam.get(teamId)
        if (cached !== undefined) return cached
        const result = await this.gql<LinearStartedStatesQuery>(
            ctx,
            'teamStartedStates',
            `query TeamStartedStates($teamId: String!) {
                team(id: $teamId) {
                    states(filter: { type: { eq: "started" } }) {
                        nodes { id position }
                    }
                }
            }`,
            { teamId }
        )
        const nodes = result.team?.states?.nodes ?? []
        const first = nodes
            .filter((node) => typeof node?.id === 'string')
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0]
        const stateId = first?.id ?? null
        this.startedStateByTeam.set(teamId, stateId)
        return stateId
    }

    private sessionIdFromScopeKey(scopeKey: string): string {
        const segments = scopeKey.split(':')
        const sessionId = segments[2]
        if (segments[0] !== 'linear' || !sessionId)
            throw new BadRequestException(`invalid linear scopeKey ${scopeKey}`)
        return sessionId
    }

    private requireCredentials(ctx: ChannelContext): LinearChannelCredentials {
        const credentials = ctx.credentials as LinearChannelCredentials | null
        if (!credentials)
            throw new BadRequestException('linear credentials missing')
        return credentials
    }

    private async createActivity(
        ctx: ChannelContext,
        agentSessionId: string,
        content: LinearActivityContent,
        opts?: { ephemeral?: boolean }
    ): Promise<string | undefined> {
        const data = await this.gql<{
            agentActivityCreate?: {
                success?: boolean
                agentActivity?: { id?: string }
            }
        }>(
            ctx,
            'agentActivityCreate',
            `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
                agentActivityCreate(input: $input) {
                    success
                    agentActivity { id }
                }
            }`,
            {
                input: {
                    agentSessionId,
                    content,
                    ...(opts?.ephemeral ? { ephemeral: true } : {})
                }
            }
        )
        return data.agentActivityCreate?.agentActivity?.id
    }

    private async fetchIdentity(
        ctx: ChannelContext,
        opts?: { forceToken?: boolean }
    ): Promise<{
        id: string
        name: string
        organizationId: string
        organizationName: string
        organizationUrlKey: string
    }> {
        const data = await this.gql<{
            viewer?: { id?: string; name?: string; displayName?: string }
            organization?: { id?: string; name?: string; urlKey?: string }
        }>(
            ctx,
            'viewer',
            `query LinearIdentity {
                viewer { id name displayName }
                organization { id name urlKey }
            }`,
            {},
            opts
        )
        const id = data.viewer?.id
        const organizationId = data.organization?.id
        if (!id || !organizationId)
            throw new Error('linear identity query returned no app user')
        return {
            id,
            name: data.viewer?.displayName ?? data.viewer?.name ?? id,
            organizationId,
            organizationName: data.organization?.name ?? organizationId,
            organizationUrlKey: data.organization?.urlKey ?? ''
        }
    }

    private async gql<T>(
        ctx: ChannelContext,
        operation: string,
        query: string,
        variables: Record<string, unknown>,
        opts?: { forceToken?: boolean }
    ): Promise<T> {
        const credentials = this.requireCredentials(ctx)
        const manualToken = (credentials.accessToken ?? '').length > 0
        let token = await this.getAccessToken(ctx, opts?.forceToken === true)
        let res = await this.postGraphql(operation, token, query, variables)
        if (res.status === 401 && !manualToken) {
            // The 30-day app token may have been revoked early (secret rotated,
            // scope change). One forced re-mint distinguishes that from real
            // credential failure.
            this.invalidateToken(ctx)
            token = await this.getAccessToken(ctx, true)
            res = await this.postGraphql(operation, token, query, variables)
        }
        if (res.status === 401)
            throw new ChannelSendError(
                'forbidden',
                `linear ${operation} unauthorized`
            )
        if (res.status === 429)
            throw new ChannelSendError(
                'rate_limited',
                `linear ${operation} rate limited`,
                { retryAfterMs: res.retryAfterMs ?? LINEAR_RATE_LIMIT_RETRY_MS }
            )
        const errors = Array.isArray(res.json?.errors) ? res.json.errors : []
        if (errors.length > 0) throw classifyLinearError(operation, errors)
        if (!res.ok || !res.json?.data)
            throw new Error(
                `linear ${operation} failed: status=${res.status} ${truncate(res.text, 200)}`
            )
        return res.json.data as T
    }

    private async postGraphql(
        operation: string,
        token: string,
        query: string,
        variables: Record<string, unknown>
    ): Promise<{
        ok: boolean
        status: number
        text: string
        retryAfterMs: number | null
        json: { data?: unknown; errors?: unknown } | null
    }> {
        return channelProviderJsonRequest<{ data?: unknown; errors?: unknown }>(
            {
                provider: 'linear',
                operation,
                url: LINEAR_GRAPHQL_URL,
                init: {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ query, variables })
                }
            }
        )
    }

    private tokenCacheKey(ctx: ChannelContext): string {
        const credentials = ctx.credentials as LinearChannelCredentials | null
        return `${ctx.channel.id}:${credentials?.clientId ?? ''}`
    }

    private invalidateToken(ctx: ChannelContext): void {
        this.tokenCache.delete(this.tokenCacheKey(ctx))
    }

    private async getAccessToken(
        ctx: ChannelContext,
        force = false
    ): Promise<string> {
        const credentials = this.requireCredentials(ctx)
        const manual = credentials.accessToken
        // A hand-pasted token is used verbatim: there is nothing to mint, so
        // caching it would only add a way for it to go stale.
        if (manual) return manual
        if (!credentials.clientId || !credentials.clientSecret)
            throw new BadRequestException(
                'linear clientId/clientSecret missing'
            )
        const cacheKey = this.tokenCacheKey(ctx)
        if (!force) {
            const cached = this.tokenCache.get(cacheKey)
            if (cached && cached.expiresAt - Date.now() > LINEAR_TOKEN_SKEW_MS)
                return cached.token
        }
        const basic = Buffer.from(
            `${credentials.clientId}:${credentials.clientSecret}`
        ).toString('base64')
        const res = await channelProviderJsonRequest<{
            access_token?: string
            expires_in?: number
            error_description?: string
        }>({
            provider: 'linear',
            operation: 'oauth/token',
            url: LINEAR_TOKEN_URL,
            init: {
                method: 'POST',
                headers: {
                    Authorization: `Basic ${basic}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'client_credentials',
                    scope: LINEAR_TOKEN_SCOPE
                }).toString()
            }
        })
        const token = res.json?.access_token
        if (!res.ok || typeof token !== 'string' || token.length === 0)
            throw new ChannelSendError(
                'forbidden',
                `linear token request failed: status=${res.status} ${res.json?.error_description ?? truncate(res.text, 200)}`
            )
        const expiresIn = Number(res.json?.expires_in ?? 0)
        const ttlMs =
            Number.isFinite(expiresIn) && expiresIn > 0
                ? expiresIn * 1000
                : 24 * 60 * 60 * 1000
        this.tokenCache.set(cacheKey, {
            token,
            expiresAt:
                Date.now() + Math.max(ttlMs - LINEAR_TOKEN_SKEW_MS, 60_000)
        })
        return token
    }
}

// evaluateInboundActor receives the whole ChannelConfig union; this keeps the
// cast local without importing every provider's config shape.
type ChannelConfigLike = Parameters<
    NonNullable<ChannelProvider['evaluateInboundActor']>
>[1]

const optionalString = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

// Insertion-order eviction: Sets iterate oldest-first, and each entry only
// memoizes an idempotent write, so dropping the oldest is always safe.
const rememberCapped = (
    set: Set<string>,
    value: string,
    cap: number
): void => {
    set.add(value)
    if (set.size <= cap) return
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
}

const stringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? Array.from(
              new Set(
                  value
                      .filter(
                          (item): item is string =>
                              typeof item === 'string' && item.trim().length > 0
                      )
                      .map((item) => item.trim())
              )
          )
        : []

// Linear has no message-edit API, so a streaming preview is impossible;
// 'preview' would silently behave as 'activity' anyway.
const parseLinearProgressMode = (value: unknown): ChannelProgressMode =>
    value === 'final' ? 'final' : 'activity'

const lowercaseHeaders = (
    headers: Record<string, string>
): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers ?? {}))
        out[key.toLowerCase()] = value
    return out
}

const displayNameOf = (
    user: LinearUserPayload | null | undefined
): string | null => {
    if (typeof user?.displayName === 'string' && user.displayName.trim())
        return user.displayName.trim()
    if (typeof user?.name === 'string' && user.name.trim())
        return user.name.trim()
    return null
}

// A mention renders in the comment body as a profile link; the agent does not
// need to read its own name back. Best-effort: leaving it in is harmless.
const stripLeadingMention = (body: string): string =>
    body.replace(
        /^\s*(?:@\S+|\[[^\]]*\]\(https:\/\/linear\.app\/[^)]*\/profiles\/[^)]*\)|https:\/\/linear\.app\/\S*\/profiles\/\S*)\s*/,
        ''
    )

const delegationDirective = (
    issue: LinearIssuePayload | null | undefined
): string => {
    const identifier =
        typeof issue?.identifier === 'string' ? issue.identifier : null
    const title = typeof issue?.title === 'string' ? issue.title : null
    // The issue body reaches the turn as the Linear issue context block above
    // this directive, so the directive points at it rather than repeating it.
    const tail =
        'Work it using the issue details in the Linear issue context above, and reply with your result.'
    if (identifier && title)
        return `You have been delegated Linear issue ${identifier}: ${title}. ${tail}`
    if (identifier)
        return `You have been delegated Linear issue ${identifier}. ${tail}`
    return `You have been delegated a Linear issue. ${tail}`
}

const LINEAR_ERROR_KINDS: Record<
    string,
    'forbidden' | 'not_found' | 'bad_format' | 'rate_limited'
> = {
    AUTHENTICATION_ERROR: 'forbidden',
    FORBIDDEN: 'forbidden',
    FEATURE_NOT_ACCESSIBLE: 'forbidden',
    ENTITY_NOT_FOUND: 'not_found',
    INVALID_INPUT: 'bad_format',
    BAD_USER_INPUT: 'bad_format',
    RATELIMITED: 'rate_limited'
}

// Positive identification only: an unrecognized code stays a plain Error so the
// bridge's generic retry ladder handles it instead of dead-lettering the reply.
const classifyLinearError = (operation: string, errors: unknown[]): Error => {
    const first = errors[0] as
        | { message?: unknown; extensions?: { code?: unknown; type?: unknown } }
        | undefined
    const message =
        typeof first?.message === 'string'
            ? first.message
            : 'unknown graphql error'
    const code =
        typeof first?.extensions?.code === 'string'
            ? first.extensions.code
            : typeof first?.extensions?.type === 'string'
              ? first.extensions.type
              : null
    const kind = code ? LINEAR_ERROR_KINDS[code.toUpperCase()] : undefined
    if (kind === 'rate_limited')
        return new ChannelSendError('rate_limited', message, {
            retryAfterMs: LINEAR_RATE_LIMIT_RETRY_MS
        })
    if (kind) return new ChannelSendError(kind, message)
    return new Error(`linear ${operation} failed: ${message}`)
}

const truncate = (value: string, max: number): string =>
    value.length <= max ? value : `${value.slice(0, max - 1)}…`

// Deliberately not unref'd: a caller is awaiting this before it finishes real
// work, so the timer must keep the loop alive the way the pending work would.
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms)
    })

// Claude Code's TodoWrite is the checklist Linear's session plan renders; Codex
// exposes the same idea as update_plan.
const isPlanTool = (toolName: string): boolean =>
    toolName === 'TodoWrite' || toolName === 'update_plan'

const PLAN_STATUS: Record<string, LinearPlanStep['status']> = {
    pending: 'pending',
    in_progress: 'inProgress',
    inprogress: 'inProgress',
    inProgress: 'inProgress',
    completed: 'completed',
    complete: 'completed',
    canceled: 'canceled',
    cancelled: 'canceled'
}

// Linear replaces the plan wholesale on every update, so a partial or garbled
// payload must yield nothing rather than a truncated checklist.
const parsePlanSteps = (args: unknown): LinearPlanStep[] => {
    const todos = (args as { todos?: unknown } | null)?.todos
    if (!Array.isArray(todos)) return []
    const steps: LinearPlanStep[] = []
    for (const todo of todos) {
        const item = todo as { content?: unknown; status?: unknown }
        if (typeof item?.content !== 'string' || item.content.trim() === '')
            continue
        const status =
            typeof item.status === 'string'
                ? (PLAN_STATUS[item.status] ?? 'pending')
                : 'pending'
        steps.push({ content: truncate(item.content.trim(), 500), status })
    }
    return steps
}

// Linear renders an action as "<action> <parameter>" on one line, so the
// parameter has to read like the thing the tool acted on ("Searching" /
// "San Francisco Weather"), not like the call's arguments. Probing argument
// names instead of tool names keeps this working across frameworks and MCP
// servers, whose tool names drift but whose argument names are conventional.
const ACTION_PARAMETER_KEYS = [
    'command',
    'query',
    'pattern',
    'url',
    'file_path',
    'notebook_path',
    'path',
    'skill',
    'description',
    'prompt',
    'name'
]

const summarizeArgs = (args: unknown): string => {
    if (args === null || args === undefined) return ''
    if (typeof args === 'string') return clipParameter(args)
    if (typeof args !== 'object') return clipParameter(String(args))
    const record = args as Record<string, unknown>
    for (const key of ACTION_PARAMETER_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '')
            return clipParameter(value)
    }
    const strings = Object.values(record).filter(
        (value): value is string => typeof value === 'string' && value !== ''
    )
    if (strings.length === 1) return clipParameter(strings[0])
    try {
        return clipParameter(JSON.stringify(args))
    } catch {
        return ''
    }
}

// Heredocs and multi-line prompts are common tool arguments and would break
// Linear's single-line action row.
const clipParameter = (value: string): string =>
    truncate(value.replace(/\s+/g, ' ').trim(), LINEAR_ACTION_PARAMETER_MAX)
