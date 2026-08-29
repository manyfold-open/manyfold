import {
    CHAT_UPLOAD_MAX_COUNT,
    CHAT_UPLOAD_MAX_FILE_BYTES,
    CHAT_UPLOAD_MAX_TOTAL_BYTES,
    ChannelConfig,
    ChannelCredentials,
    ChannelFinalMessageMode,
    ChannelProgressMode,
    isAllowedChatAttachment
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    HttpException,
    Injectable,
    Logger
} from '@nestjs/common'
import type { ChannelDeliveryRow, ChannelRow } from '@manyfold/db'
import {
    ChatService,
    InflightTurnConflictError,
    type ChatTurnObserver
} from '@/modules/chat/chat.service'
import {
    ChatApiFileService,
    type IngestFile,
    type IngestedFiles,
    type OutboundFile,
    type OutboundFileRef
} from '@/modules/chat/api-files/chat-api-file.service'
import { resolveFileInput } from '@/modules/openai-compat/openai-file-source'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import {
    UnsupportedEventError,
    historyAttachmentLabel,
    historyAttachmentUnavailableLabel,
    type ChannelCommandView,
    type ChannelContext,
    type ChannelHistoryAttachment,
    type ChannelHistoryContext,
    type ChannelProvider,
    type ChannelSendTarget,
    type NormalizedInboundAction,
    type NormalizedInboundAttachment,
    type NormalizedInboundEvent,
    type PreviewHandle
} from './channel-provider'
import { buildChannelContextBlock } from './channel-context-projection'
import { ChannelProviderRegistry } from './channel-provider-registry.service'
import {
    ChannelSessionRouter,
    type ResolvedSession
} from './channel-session-router.service'
import {
    mostRecentDate,
    parseHistoryBackfillLimit,
    shouldAutoResetOnIdle
} from './config-helpers'
import {
    ChannelSendError,
    classifySendError,
    isPermanentSendErrorKind,
    sendRetryDelayMs
} from './channel-send-error'
import {
    composeCollectedInbound,
    parseStoredInboundEvent
} from './inbound-collect'
import {
    ChannelsRepository,
    INFLIGHT_QUEUE_REASON
} from './channels.repository'
import { ChannelSlashDispatcher } from './slash/slash-dispatcher.service'
import { buildHelpText } from './slash/commands'
import { extractWorkspaceFileRefs } from './workspace-file-refs'

const PREVIEW_THROTTLE_MS = 800
// Consecutive preview-update failures before updates are disabled for the
// rest of the turn (platform is throttling or rejecting edits; keep the
// final reply path, stop the churn).
const PREVIEW_STRIKE_LIMIT = 3
// Ceiling on how long the terminal reply waits for queued progress projections
// to drain. Reaching it means a projection may still land after the reply, so
// prefer the reply: it is the part the user is waiting for.
const TAP_FENCE_MAX_MS = 10_000
const SUMMARY_MAX_LEN = 200
const ERROR_REPLY_MAX_LEN = 200
const INBOUND_PROCESSING_STALE_MS = 5 * 60 * 1000
const INBOUND_MAX_ATTEMPTS = 5
const INBOUND_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000]
const OUTBOUND_MAX_ATTEMPTS = 5
const OUTBOUND_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]
const OUTBOUND_ENQUEUE_GRACE_MS = 120_000
const OUTBOUND_INACTIVE_RETRY_MS = 900_000
// Reply-expectation rows ('pending' outbox rows written at turn start) are
// reconciled from persisted turn state once old enough that the inline
// finalize path is clearly not coming (crash, suspend, hung stream).
const PENDING_REPLY_MIN_AGE_MS = 2 * 60_000
const PENDING_REPLY_MAX_TURN_MS = 3 * 60 * 60_000
// Bounds how long handleInbound awaits a live turn. The reply itself does not
// depend on this wait: the observer finalizes whenever the terminal arrives,
// and the pending-row reconcile covers observers that never fire. Keeping the
// wait bounded stops one hung turn from wedging the sequential replay pump.
const REPLY_WAIT_MAX_MS = 60_000
// Messages that arrive while a turn is in flight are requeued as inbound
// deliveries instead of dropped, then replayed FIFO (one per turn) by the
// post-finalize drain kick, with the 60s sweep as the passive fallback.
const INFLIGHT_QUEUE_CAP = 5
const INFLIGHT_REQUEUE_DELAY_MS = 15_000
const INFLIGHT_DRAIN_POLL_MS = 200
const INFLIGHT_DRAIN_POLL_MAX = 10
const STOPPED_MARKER = '⏹ stopped'
// History-backfill attachments compete for at most this many file slots so a
// busy channel's backlog can never crowd out the triggering message's own
// attachments (which are placed first and win the shared count/size caps).
const HISTORY_ATTACHMENT_MAX_COUNT = 4

const isDeterministicInboundError = (err: unknown): boolean =>
    err instanceof UnsupportedEventError ||
    (err instanceof HttpException &&
        err.getStatus() < 500 &&
        !(err instanceof InflightTurnConflictError))

// The ⚠ copy must match what actually happened (#577): only a capability gap
// is "this agent" territory; an ingest failure is transient and retryable, and
// saying otherwise teaches users the agent cannot take files at all.
type AttachmentDegradeReason =
    | 'unsupported_framework'
    | 'attachments_unavailable'
    | 'ingest_failed'

const attachmentDegradeNotice = (
    reason: AttachmentDegradeReason,
    // True when other files (history-backfill attachments) still made it into
    // the turn, so "text only" would misstate what the agent received.
    hasFiles = false
): string => {
    if (reason === 'unsupported_framework')
        return '⚠ This agent does not support file attachments — continuing with text only.'
    if (reason === 'ingest_failed')
        return '⚠ Attachments could not be processed this time — continuing with text only. Please try sending them again.'
    if (hasFiles)
        return '⚠ Your attachment(s) could not be processed — continuing without them.'
    return '⚠ Attachments could not be processed — continuing with text only.'
}

const attachmentDropNotice = (
    reason: AttachmentDegradeReason | false
): string =>
    reason === 'unsupported_framework'
        ? '⚠ This agent does not support file attachments, so there was nothing to send.'
        : '⚠ Could not process the attachment(s), so there was nothing to send to the agent.'

export interface ChannelInboundIntake {
    delivery: ChannelDeliveryRow
    created: boolean
}

@Injectable()
export class ChannelBridgeService {
    private readonly logger = new Logger(ChannelBridgeService.name)
    private replaying = false
    private sweepingOutbound = false
    private reconcilingPending = false

    constructor(
        private readonly repo: ChannelsRepository,
        private readonly router: ChannelSessionRouter,
        private readonly chat: ChatService,
        private readonly providers: ChannelProviderRegistry,
        private readonly crypto: CryptoService,
        private readonly telemetry: TelemetryService,
        private readonly slash: ChannelSlashDispatcher,
        private readonly apiFiles: ChatApiFileService
    ) {}

    buildContext(channel: ChannelRow): ChannelContext {
        const provider = this.providers.get(channel.provider)
        const config = provider.validateConfig(channel.configJson)
        const credentials = this.decryptCredentials(channel)
        return { channel, config, credentials }
    }

    // Agent-initiated outbound send: durable delivery row first, then the
    // inline provider send, with the existing outbound sweep as the retry
    // path. Callers have already authorized the (agent, channel) pair.
    async sendAgentDirect(
        channel: ChannelRow,
        target: ChannelSendTarget,
        text: string | null,
        files: OutboundFileRef[] = [],
        // Stamped onto the delivery row so a caller that retries a send whose
        // response it never saw can recognize its own earlier attempt. Text and
        // files are separate rows with independent retries, so they cannot
        // share one key.
        idempotencyKey: string | null = null
    ): Promise<{
        deliveryId: bigint
        status: 'sent' | 'queued' | 'failed'
        providerMessageId: string | null
        files?: {
            deliveryId: bigint
            status: 'sent' | 'queued' | 'failed'
            providerMessageId: string | null
        }
    }> {
        const provider = this.providers.get(channel.provider)
        if (text === null && files.length === 0)
            throw new BadRequestException('text or files is required')
        if (text !== null && typeof provider.sendDirect !== 'function')
            throw new BadRequestException(
                `${channel.provider} channels do not support agent send yet`
            )
        if (
            files.length > 0 &&
            typeof provider.sendDirectAttachments !== 'function'
        )
            throw new BadRequestException(
                `${channel.provider} channels do not support agent file send yet`
            )
        const ctx = this.buildContext(channel)
        // Text lands before files so a caption reads ahead of its attachment;
        // separate delivery rows keep their retries independent (a file retry
        // must never re-send the text).
        const textOutcome =
            text !== null
                ? await this.attemptAgentDelivery({
                      channel,
                      scopeKey: agentSendScopeKey(target),
                      targetKind: target.kind,
                      eventJson: { text, target },
                      summaryText: truncate(text, SUMMARY_MAX_LEN),
                      idempotencyKey,
                      send: () => provider.sendDirect!(ctx, target, text)
                  })
                : null
        const fileOutcome =
            files.length > 0
                ? await this.attemptAgentDelivery({
                      channel,
                      scopeKey: agentSendScopeKey(target),
                      targetKind: target.kind,
                      eventJson: {
                          target,
                          files: files.map((ref) => ({
                              relPath: ref.relPath,
                              name: ref.name
                          }))
                      },
                      summaryText: truncate(
                          `[files] ${files.map((ref) => ref.name).join(', ')}`,
                          SUMMARY_MAX_LEN
                      ),
                      idempotencyKey: idempotencyKey
                          ? `${idempotencyKey}:files`
                          : null,
                      send: () =>
                          this.deliverAgentFiles(
                              channel,
                              ctx,
                              provider,
                              target,
                              files
                          )
                  })
                : null
        const primary = textOutcome ?? fileOutcome
        if (!primary) throw new BadRequestException('text or files is required')
        return {
            ...primary,
            ...(textOutcome && fileOutcome ? { files: fileOutcome } : {})
        }
    }

    // Agent-initiated send into an existing conversation scope: same durable
    // row + sweep-retry contract as sendAgentDirect, but routed through the
    // provider's scope-addressed sendText, which every provider implements —
    // this is how automation delivery reaches Discord/Slack. Text-only: the
    // sweep's stored-files retry branch requires an explicit target.
    async sendAgentScoped(
        channel: ChannelRow,
        scopeKey: string,
        text: string
    ): Promise<{
        deliveryId: bigint
        status: 'sent' | 'queued' | 'failed'
        providerMessageId: string | null
    }> {
        const provider = this.providers.get(channel.provider)
        const session = await this.repo.findActiveSession(channel.id, scopeKey)
        if (!session)
            throw new BadRequestException(
                'no active conversation for this scope on the channel'
            )
        const ctx = this.buildContext(channel)
        // eventJson deliberately carries no target: the outbound sweep routes
        // target-less rows through sendText(scopeKey), so retries follow the
        // same path as the inline attempt.
        return this.attemptAgentDelivery({
            channel,
            scopeKey,
            targetKind: 'scope',
            eventJson: { text },
            summaryText: truncate(text, SUMMARY_MAX_LEN),
            send: () => provider.sendText(ctx, scopeKey, text)
        })
    }

    private async attemptAgentDelivery(opts: {
        channel: ChannelRow
        scopeKey: string
        targetKind: string
        eventJson: Record<string, unknown>
        summaryText: string
        idempotencyKey?: string | null
        send: () => Promise<{ providerMessageId?: string }>
    }): Promise<{
        deliveryId: bigint
        status: 'sent' | 'queued' | 'failed'
        providerMessageId: string | null
    }> {
        const { channel } = opts
        const delivery = await this.repo.insertDelivery({
            channelId: channel.id,
            chatSessionId: null,
            chatMessageId: null,
            direction: 'outbound',
            scopeKey: opts.scopeKey,
            providerEventId: opts.idempotencyKey ?? null,
            providerMessageId: null,
            eventJson: opts.eventJson,
            summaryText: opts.summaryText,
            status: 'queued',
            errorMessage: null,
            sendAttemptStartedAt: new Date(),
            nextAttemptAt: new Date(Date.now() + OUTBOUND_ENQUEUE_GRACE_MS),
            createdAt: new Date()
        })
        try {
            const sent = await opts.send()
            await this.repo.updateDelivery(delivery.id, {
                status: 'sent',
                providerMessageId: sent.providerMessageId ?? null,
                errorMessage: null,
                attemptCount: 1,
                sendAttemptStartedAt: null,
                nextAttemptAt: null
            })
            this.telemetry.event('channel.agent_send.sent', {
                channelId: channel.id,
                targetKind: opts.targetKind
            })
            return {
                deliveryId: delivery.id,
                status: 'sent',
                providerMessageId: sent.providerMessageId ?? null
            }
        } catch (err) {
            const classified = classifySendError(err)
            const permanent = isPermanentSendErrorKind(classified.kind)
            await this.repo.updateDelivery(delivery.id, {
                status: permanent ? 'dead' : 'failed',
                attemptCount: 1,
                errorMessage: (err as Error).message,
                sendAttemptStartedAt: null,
                nextAttemptAt: permanent
                    ? null
                    : new Date(
                          Date.now() +
                              sendRetryDelayMs(
                                  classified,
                                  0,
                                  OUTBOUND_RETRY_BACKOFF_MS
                              )
                      )
            })
            this.telemetry.error('channel.agent_send.failed', err as Error, {
                channelId: channel.id,
                targetKind: opts.targetKind,
                errorKind: classified.kind
            })
            return {
                deliveryId: delivery.id,
                status: permanent ? 'failed' : 'queued',
                providerMessageId: null
            }
        }
    }

    // Workspace files are read at SEND time (inline and on every sweep retry)
    // so a retry always ships current bytes; a path that resolves to nothing
    // is permanent — the agent named a file that is not there.
    private async deliverAgentFiles(
        channel: ChannelRow,
        ctx: ChannelContext,
        provider: ChannelProvider,
        target: ChannelSendTarget,
        refs: OutboundFileRef[]
    ): Promise<{ providerMessageId?: string }> {
        if (typeof provider.sendDirectAttachments !== 'function')
            throw new ChannelSendError(
                'not_found',
                `${channel.provider} channels do not support agent file send`
            )
        const files = await this.apiFiles.readWorkspaceFiles(
            channel.agentId,
            refs
        )
        if (files.length === 0)
            throw new ChannelSendError(
                'not_found',
                'no readable files at the given workspace paths'
            )
        return provider.sendDirectAttachments(
            ctx,
            target,
            files.map((file) => ({
                name: file.name,
                contentType: file.contentType,
                bytes: file.bytes
            }))
        )
    }

    async handleInbound(
        channel: ChannelRow,
        event: NormalizedInboundEvent,
        intake?: ChannelInboundIntake
    ): Promise<void> {
        if (await this.repo.isOwnerDeactivated(channel.userId)) {
            this.telemetry.event('channel.inbound.ignored', {
                channelId: channel.id,
                providerEventId: event.providerEventId,
                reason: 'owner_deactivated'
            })
            return
        }
        const inbound =
            intake ?? (await this.recordInboundEvent(channel.id, event))
        const deliveryId = inbound.delivery.id
        const claimed = await this.repo.claimInboundEvent(
            deliveryId,
            new Date(Date.now() - INBOUND_PROCESSING_STALE_MS)
        )
        if (!claimed) {
            this.telemetry.event('channel.inbound.ignored', {
                channelId: channel.id,
                providerEventId: event.providerEventId,
                reason: 'duplicate_event_id'
            })
            return
        }

        let inboundSettled = false
        const ctx = this.buildContext(channel)
        const provider = this.providers.get(channel.provider)
        const typing = createTypingHolder()
        // Agent-managed reply: the agent delivers through its own channel
        // tools, so this turn forwards structured source context and Manyfold
        // suppresses every outbound of its own (preview, final post, durable
        // reply expectation, ack reaction, typing).
        const agentManagedReply = ctx.config.agentManagedReply === true
        try {
            // External-actor policy (allowlist + operator rights + workspace
            // binding) runs before slash/mention handling so a disallowed
            // sender can neither consume a turn nor run a command. The rejection
            // is recorded (not silently dropped) so it is auditable in
            // deliveries + telemetry. Policy sees only platform ids, so it runs
            // before the (async, paid) display-name enrichment below.
            const policy = provider.evaluateInboundActor?.(
                event,
                ctx.config
            ) ?? {
                allowed: true,
                operator: true
            }
            if (!policy.allowed) {
                const rejected = provider.computeScopeKey(event, ctx.config)
                await this.repo.updateDelivery(deliveryId, {
                    scopeKey: rejected.scopeKey,
                    status: 'dropped',
                    errorMessage: `${policy.reason ?? 'actor_rejected'}:${event.senderId}`
                })
                inboundSettled = true
                this.telemetry.event('channel.inbound.rejected', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: policy.reason ?? 'actor_rejected',
                    senderId: event.senderId
                })
                return
            }

            // Display-name enrichment runs before computeScopeKey so a
            // private scope's session name benefits from the resolved name.
            if (
                !event.senderName &&
                typeof provider.resolveSenderName === 'function'
            ) {
                try {
                    event.senderName =
                        (await provider.resolveSenderName(ctx, event)) ?? null
                } catch (err) {
                    this.logger.warn(
                        `sender name resolve failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                }
            }

            const { scopeKey, scopeName } = provider.computeScopeKey(
                event,
                ctx.config
            )

            const slashText = stripMention(event.text)
            const parsedSlash = this.slash.tryParse(slashText)

            // A native command invocation (e.g. a Slack slash command) whose
            // name we don't recognize must get command help — never fall
            // through to the agent as chat (it arrives with isMention set).
            if (!parsedSlash && event.commandInvocation) {
                await this.sendSlashReply(
                    ctx,
                    provider,
                    scopeKey,
                    {
                        replyText: `Unknown command «${event.text}».\n\n${buildHelpText()}`
                    },
                    event.providerEventId
                )
                await this.repo.updateDelivery(deliveryId, {
                    scopeKey,
                    status: 'dropped',
                    errorMessage: 'unknown_command'
                })
                inboundSettled = true
                this.telemetry.event('channel.inbound.ignored', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: 'unknown_command'
                })
                return
            }

            // Recognized slash commands are bot-directed by construction, so
            // they bypass the group mention gate; anything else still needs a
            // mention in groups.
            if (!parsedSlash && !this.shouldRespond(event, ctx.config)) {
                await this.repo.updateDelivery(deliveryId, {
                    scopeKey,
                    status: 'dropped',
                    errorMessage: 'mention_required'
                })
                inboundSettled = true
                this.telemetry.event('channel.inbound.ignored', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: 'mention_required'
                })
                return
            }

            if (parsedSlash) {
                const result = await this.slash.dispatch(parsedSlash, {
                    channel,
                    scopeKey,
                    scopeName,
                    senderId: event.senderId,
                    senderName: event.senderName ?? null,
                    operator: policy.operator
                })
                await this.sendSlashReply(
                    ctx,
                    provider,
                    scopeKey,
                    result,
                    event.commandInvocation ? event.providerEventId : undefined
                )
                await this.repo.updateDelivery(deliveryId, {
                    scopeKey,
                    status: result.denied ? 'dropped' : 'accepted',
                    errorMessage: result.denied
                        ? `operator_required:/${parsedSlash.command}:${event.senderId}`
                        : `slash:/${parsedSlash.command}`
                })
                inboundSettled = true
                if (result.denied)
                    this.telemetry.event('channel.slash.denied', {
                        channelId: channel.id,
                        command: result.command,
                        senderId: event.senderId
                    })
                else
                    this.telemetry.event('channel.slash.dispatched', {
                        channelId: channel.id,
                        command: result.command,
                        sideEffect: result.sideEffect
                    })
                return
            }

            let resolved = await this.router.resolveActive(
                channel,
                scopeKey,
                scopeName,
                {
                    senderId: event.senderId,
                    threadId: event.threadId ?? null
                }
            )

            // A prior attempt at this delivery may have created its turn and
            // died before recording that fact. If that turn exists, adopt it —
            // re-sending would run the same message twice.
            if (claimed.turnMessageId) {
                const adopted = await this.adoptExistingTurn({
                    channel,
                    deliveryId,
                    turnMessageId: claimed.turnMessageId,
                    chatSessionId: resolved.chatSessionId,
                    scopeKey,
                    suppressDelivery: agentManagedReply
                })
                if (adopted) {
                    inboundSettled = true
                    return
                }
            }

            const idled = await this.maybeAutoResetOnIdle(
                channel,
                ctx,
                resolved,
                scopeName,
                event
            )
            if (idled) {
                resolved = idled
                this.telemetry.event('channel.session.idle_reset', {
                    channelId: channel.id,
                    chatSessionId: resolved.chatSessionId,
                    scopeKey
                })
            }

            // Skip the backfill fetch when a turn is already running: this
            // event is about to be queued and will be re-driven (and
            // re-backfilled against the by-then-advanced boundary) on drain, so
            // fetching now — including downloading any history attachments —
            // just wastes work on a result we discard.
            const history = (await this.chat.hasInflightTurn(
                resolved.chatSessionId
            ))
                ? null
                : await this.fetchHistoryForBackfill(
                      channel,
                      ctx,
                      provider,
                      event,
                      scopeKey
                  )
            const files = await this.prepareInboundFiles(
                ctx,
                provider,
                event,
                resolved.chatSessionId,
                this.selectHistoryAttachments(
                    channel,
                    event,
                    history?.attachments ?? []
                )
            )
            const hasFiles =
                files.attachments.length > 0 || files.uploads.length > 0
            if (event.text.trim().length === 0 && !hasFiles) {
                await this.repo.updateDelivery(deliveryId, {
                    chatSessionId: resolved.chatSessionId,
                    scopeKey,
                    status: 'dropped',
                    errorMessage: 'attachments_unavailable'
                })
                inboundSettled = true
                this.telemetry.event('channel.inbound.ignored', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: 'attachments_unavailable'
                })
                await provider
                    .sendText(
                        ctx,
                        scopeKey,
                        attachmentDropNotice(files.degraded),
                        { nonConversational: true }
                    )
                    .catch(() => undefined)
                return
            }
            if (files.degraded)
                await provider
                    .sendText(
                        ctx,
                        scopeKey,
                        attachmentDegradeNotice(files.degraded, hasFiles),
                        { nonConversational: true }
                    )
                    .catch(() => undefined)

            const composedText = composeTurnText(
                event,
                history,
                files.materializedUrls
            )
            const contextBlock =
                ctx.config.contextProjection === false
                    ? ''
                    : buildChannelContextBlock({
                          channel,
                          event,
                          session: resolved.session,
                          receivedAt: inbound.delivery.createdAt
                      })
            let replyBlock = ''
            if (
                event.replyToMessageId &&
                typeof provider.fetchReplyContext === 'function'
            ) {
                try {
                    replyBlock =
                        (await provider.fetchReplyContext(ctx, event)) ?? ''
                    if (replyBlock)
                        this.telemetry.event('channel.inbound.reply_context', {
                            channelId: channel.id,
                            providerEventId: event.providerEventId,
                            chars: replyBlock.length
                        })
                } catch (err) {
                    this.logger.warn(
                        `reply context fetch failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                }
            }
            const turnText = [contextBlock, replyBlock, composedText]
                .filter((part) => part.length > 0)
                .join('\n\n')

            const outbound = this.createOutboundObserver({
                channel,
                ctx,
                provider,
                scopeKey,
                chatSessionId: resolved.chatSessionId,
                channelSessionId: resolved.session.id,
                typing,
                replyToProviderMessageId: event.replyTargetId,
                inboundMessageId: event.messageId ?? null,
                suppressDelivery: agentManagedReply
            })
            // sendMessage atomically claims the session's single turn slot and
            // throws InflightTurnConflictError if a turn is already running, which
            // we queue for replay after the current turn. This is the
            // cross-instance guard against two inbound events starting
            // concurrent turns.
            //
            // The planned assistant id is persisted on the delivery row FIRST:
            // if the process dies after the turn is created but before the row
            // is settled, the replay finds the turn via this id and adopts it
            // instead of running the message a second time.
            const plannedTurnId = randomUUID()
            await this.repo.updateDelivery(deliveryId, {
                chatSessionId: resolved.chatSessionId,
                scopeKey,
                turnMessageId: plannedTurnId
            })
            let sent: Awaited<ReturnType<ChatService['sendMessage']>>
            try {
                sent = await this.chat.sendMessage(
                    channel.userId,
                    channel.agentId,
                    resolved.chatSessionId,
                    turnText,
                    files.attachments,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    outbound.observer,
                    [],
                    files.uploads,
                    {
                        assistantMessageId: plannedTurnId,
                        channelSource: agentManagedReply
                            ? {
                                  provider: channel.provider,
                                  chatId: event.chatId,
                                  chatType: event.chatType,
                                  senderId: event.senderId,
                                  senderName: event.senderName ?? null,
                                  messageId: event.messageId ?? null,
                                  threadId: event.threadId ?? null,
                                  replyToMessageId:
                                      event.replyToMessageId ?? null,
                                  isMention: event.isMention,
                                  replyToken:
                                      provider.replyCredential?.(event) ?? null,
                                  mirrored:
                                      channel.origin?.kind === 'narranexus'
                              }
                            : undefined
                    }
                )
            } catch (err) {
                if (!(err instanceof InflightTurnConflictError)) throw err
                await this.queueBusyInbound({
                    ctx,
                    provider,
                    channel,
                    deliveryId,
                    preClaimErrorMessage: inbound.delivery.errorMessage,
                    claimedAttemptCount: claimed.attemptCount,
                    scopeKey,
                    chatSessionId: resolved.chatSessionId,
                    replyToProviderMessageId: event.replyTargetId
                })
                inboundSettled = true
                return
            }

            // Durable reply expectation: the observer that will finalize this
            // turn is an in-memory closure, so persist "this scope is owed a
            // reply for this assistant message" first. If the process dies or
            // the observer never fires, reconcilePendingReplies delivers from
            // the persisted turn state instead. Skipped for agent-managed
            // reply: no Manyfold delivery is owed, inline or via the sweep.
            let pendingDeliveryId: bigint | null = null
            if (!agentManagedReply)
                try {
                    const pendingReply = await this.repo.insertDelivery({
                        channelId: channel.id,
                        chatSessionId: resolved.chatSessionId,
                        chatMessageId: sent.assistantMessageId,
                        direction: 'outbound',
                        scopeKey,
                        providerEventId: null,
                        providerMessageId: null,
                        summaryText: null,
                        status: 'pending',
                        errorMessage: null,
                        createdAt: new Date()
                    })
                    pendingDeliveryId = pendingReply.id
                } catch (err) {
                    this.logger.warn(
                        `failed to record pending reply for channel=${channel.id}: ${(err as Error).message}`
                    )
                }

            await this.repo.touchSessionInbound(resolved.session.id, new Date())

            await this.repo.updateDelivery(deliveryId, {
                chatSessionId: resolved.chatSessionId,
                chatMessageId: sent.userMessage.id,
                scopeKey,
                status: 'accepted',
                errorMessage: null
            })
            inboundSettled = true
            this.telemetry.event('channel.inbound.accepted', {
                channelId: channel.id,
                chatSessionId: resolved.chatSessionId,
                sessionCreated: resolved.isNew
            })

            if (!agentManagedReply)
                this.setAckReaction(
                    ctx,
                    provider,
                    scopeKey,
                    event.messageId ?? null,
                    'working'
                )
            if (
                !agentManagedReply &&
                typeof provider.startTyping === 'function'
            ) {
                try {
                    typing.attach(
                        await provider.startTyping(ctx, scopeKey, {
                            triggerProviderMessageId: event.messageId ?? null,
                            chatSessionId: resolved.chatSessionId
                        })
                    )
                } catch (err) {
                    this.logger.warn(
                        `typing start failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                }
            }

            await outbound.startPreview()
            await outbound.wait(sent.assistantMessageId, pendingDeliveryId)
        } catch (err) {
            typing.end()
            if (!inboundSettled)
                await this.settleInboundFailure(
                    deliveryId,
                    claimed.attemptCount,
                    err
                ).catch((updateErr) =>
                    this.logger.warn(
                        `failed to mark inbound delivery=${deliveryId} failed: ${(updateErr as Error).message}`
                    )
                )
            this.telemetry.error('channel.inbound.failed', err as Error, {
                channelId: channel.id,
                providerEventId: event.providerEventId
            })
            throw err
        }
    }

    async handleInboundAction(
        channel: ChannelRow,
        action: NormalizedInboundAction
    ): Promise<void> {
        if (await this.repo.isOwnerDeactivated(channel.userId)) {
            this.telemetry.event('channel.inbound.ignored', {
                channelId: channel.id,
                providerEventId: action.providerEventId,
                reason: 'owner_deactivated'
            })
            return
        }
        const ctx = this.buildContext(channel)
        const provider = this.providers.get(channel.provider)
        const syntheticEvent: NormalizedInboundEvent = {
            providerEventId: action.providerEventId,
            chatId: action.chatId,
            chatType: action.chatType,
            senderId: action.senderId,
            senderName: action.senderName,
            text: action.action,
            threadId: action.threadId,
            isMention: true,
            raw: action.raw
        }
        const computed = provider.computeScopeKey(syntheticEvent, ctx.config)
        const scopeKey = computed.scopeKey
        if (action.scopeKey && action.scopeKey !== scopeKey) {
            this.logger.warn(
                `action scopeKey mismatch for channel=${channel.id}: payload=${action.scopeKey} computed=${scopeKey}`
            )
            this.telemetry.event('channel.action.rejected', {
                channelId: channel.id,
                providerEventId: action.providerEventId,
                reason: 'scope_mismatch'
            })
            return
        }
        const intake = await this.recordInboundEvent(channel.id, syntheticEvent)
        const deliveryId = intake.delivery.id
        const claimed = await this.repo.claimInboundEvent(
            deliveryId,
            new Date(Date.now() - INBOUND_PROCESSING_STALE_MS)
        )
        if (!claimed) {
            this.telemetry.event('channel.action.ignored', {
                channelId: channel.id,
                providerEventId: action.providerEventId,
                reason: 'duplicate_event_id'
            })
            return
        }
        try {
            // Actor policy runs after intake creation/claim (this path records
            // its delivery only after scope validation), so a rejection still
            // lands on a persisted dropped row.
            const policy = provider.evaluateInboundActor?.(
                syntheticEvent,
                ctx.config
            ) ?? { allowed: true, operator: true }
            if (!policy.allowed) {
                await this.repo.updateDelivery(deliveryId, {
                    scopeKey,
                    status: 'dropped',
                    errorMessage: `${policy.reason ?? 'actor_rejected'}:${action.senderId}`
                })
                this.telemetry.event('channel.action.rejected', {
                    channelId: channel.id,
                    providerEventId: action.providerEventId,
                    reason: policy.reason ?? 'actor_rejected',
                    senderId: action.senderId
                })
                return
            }
            const result = await this.slash.dispatchAction(action, {
                channel,
                scopeKey,
                scopeName: computed.scopeName,
                senderId: action.senderId,
                senderName: action.senderName,
                operator: policy.operator
            })
            await this.sendSlashReply(ctx, provider, scopeKey, result)
            await this.repo.updateDelivery(deliveryId, {
                scopeKey,
                status: 'accepted',
                errorMessage: `action:${action.action}`
            })
            this.telemetry.event('channel.action.dispatched', {
                channelId: channel.id,
                action: action.action,
                sideEffect: result.sideEffect
            })
        } catch (err) {
            await this.repo
                .updateDelivery(deliveryId, { scopeKey })
                .catch(() => {})
            await this.settleInboundFailure(
                deliveryId,
                claimed.attemptCount,
                err
            ).catch(() => {})
            this.telemetry.error('channel.action.failed', err as Error, {
                channelId: channel.id,
                providerEventId: action.providerEventId
            })
            throw err
        }
    }

    private async settleInboundFailure(
        deliveryId: bigint,
        attemptCount: number,
        err: unknown
    ): Promise<void> {
        const errorMessage = (err as Error).message
        if (isDeterministicInboundError(err)) {
            await this.repo.updateDelivery(deliveryId, {
                status: 'dropped',
                errorMessage
            })
            return
        }
        if (attemptCount >= INBOUND_MAX_ATTEMPTS) {
            await this.repo.updateDelivery(deliveryId, {
                status: 'dead',
                errorMessage
            })
            return
        }
        const backoff =
            INBOUND_RETRY_BACKOFF_MS[
                Math.min(attemptCount - 1, INBOUND_RETRY_BACKOFF_MS.length - 1)
            ]
        await this.repo.updateDelivery(deliveryId, {
            status: 'failed',
            errorMessage,
            nextAttemptAt: new Date(Date.now() + backoff)
        })
    }

    private async queueBusyInbound(opts: {
        ctx: ChannelContext
        provider: ChannelProvider
        channel: ChannelRow
        deliveryId: bigint
        preClaimErrorMessage: string | null
        claimedAttemptCount: number
        scopeKey: string
        chatSessionId: string
        replyToProviderMessageId?: string | null
    }): Promise<void> {
        const { ctx, provider, channel, scopeKey, chatSessionId } = opts
        // Queue notices are bot housekeeping that never enters the transcript,
        // so they must not become a history-backfill boundary.
        const replyOpts = {
            replyToProviderMessageId: opts.replyToProviderMessageId,
            nonConversational: true
        }
        // A row already carrying the queue reason has been acked once and, if
        // over cap, was already admitted — only first-time queueing is capped
        // and acked, so a re-queue (sweep/kick replay losing the lock again)
        // never re-acks or gets wrongly dropped.
        const firstQueue = opts.preClaimErrorMessage !== INFLIGHT_QUEUE_REASON
        if (firstQueue) {
            const waiting = await this.repo.countQueuedInboundForScope(
                channel.id,
                scopeKey
            )
            if (waiting >= INFLIGHT_QUEUE_CAP) {
                await provider
                    .sendText(
                        ctx,
                        scopeKey,
                        `Queue is full (${INFLIGHT_QUEUE_CAP} messages waiting) — this message was discarded.`,
                        replyOpts
                    )
                    .catch((sendErr) =>
                        this.logger.warn(
                            `failed to send queue-full reply for channel=${channel.id}: ${(sendErr as Error).message}`
                        )
                    )
                await this.repo.updateDelivery(opts.deliveryId, {
                    chatSessionId,
                    scopeKey,
                    status: 'dropped',
                    errorMessage: 'inflight_queue_full'
                })
                this.telemetry.event('channel.inbound.rejected', {
                    channelId: channel.id,
                    chatSessionId,
                    reason: 'inflight_queue_full'
                })
                return
            }
        }
        // Requeue before acking so a crash loses only the ack, never the
        // message. attemptCount is restored to its pre-claim value: busy
        // bounces must not consume the real-failure retry budget, which
        // claimInboundEvent increments on every claim. turnMessageId is
        // cleared: the planned turn lost the slot claim and never existed.
        await this.repo.updateDelivery(opts.deliveryId, {
            chatSessionId,
            chatMessageId: null,
            turnMessageId: null,
            scopeKey,
            status: 'queued',
            errorMessage: INFLIGHT_QUEUE_REASON,
            attemptCount: Math.max(0, opts.claimedAttemptCount - 1),
            nextAttemptAt: new Date(Date.now() + INFLIGHT_REQUEUE_DELAY_MS)
        })
        if (firstQueue)
            await provider
                .sendText(
                    ctx,
                    scopeKey,
                    '📬 Queued — will run after the current response finishes.',
                    replyOpts
                )
                .catch((sendErr) =>
                    this.logger.warn(
                        `failed to send queued reply for channel=${channel.id}: ${(sendErr as Error).message}`
                    )
                )
        this.telemetry.event('channel.inbound.queued', {
            channelId: channel.id,
            chatSessionId,
            scopeKey
        })
    }

    // Recovery for the crash window between turn creation and the inbound
    // row's 'accepted' flip: the row names its planned turn id. When that turn
    // exists, settle the row against it and ensure a durable reply expectation
    // exists — reconcilePendingReplies then delivers the turn's outcome.
    // Returns false when the turn never materialized (crash before creation),
    // in which case the caller proceeds with a fresh turn. Under
    // suppressDelivery no reply expectation is created: the agent delivers
    // through its own channel tools, so the sweep must not post from Manyfold.
    private async adoptExistingTurn(opts: {
        channel: ChannelRow
        deliveryId: bigint
        turnMessageId: string
        chatSessionId: string
        scopeKey: string
        suppressDelivery?: boolean
    }): Promise<boolean> {
        const outcome = await this.chat.getTurnOutcome(opts.turnMessageId)
        if (outcome.state === 'missing') return false
        if (!opts.suppressDelivery) {
            const existing = await this.repo.findOutboundByChatMessageId(
                opts.channel.id,
                opts.turnMessageId
            )
            if (!existing)
                await this.repo.insertDelivery({
                    channelId: opts.channel.id,
                    chatSessionId: opts.chatSessionId,
                    chatMessageId: opts.turnMessageId,
                    direction: 'outbound',
                    scopeKey: opts.scopeKey,
                    providerEventId: null,
                    providerMessageId: null,
                    summaryText: null,
                    status: 'pending',
                    errorMessage: null,
                    createdAt: new Date()
                })
        }
        await this.repo.updateDelivery(opts.deliveryId, {
            chatSessionId: opts.chatSessionId,
            scopeKey: opts.scopeKey,
            status: 'accepted',
            errorMessage: 'turn_adopted'
        })
        this.telemetry.event('channel.inbound.turn_adopted', {
            channelId: opts.channel.id,
            chatSessionId: opts.chatSessionId,
            outcome: outcome.state
        })
        return true
    }

    private async drainQueuedInbound(
        channelId: string,
        scopeKey: string,
        chatSessionId: string
    ): Promise<void> {
        // Collect mode (default): merge the queue's text-only prefix into one
        // turn instead of one turn per queued message. MF_CHANNEL_QUEUE_COLLECT=0
        // restores the sequential one-turn-per-message behavior.
        const collect = process.env.MF_CHANNEL_QUEUE_COLLECT !== '0'
        const row = collect
            ? await this.repo.collectQueuedInboundForScope(
                  channelId,
                  scopeKey,
                  (rows) => {
                      const composed = composeCollectedInbound(rows)
                      if (composed)
                          this.telemetry.event('channel.inbound.collected', {
                              channelId,
                              scopeKey,
                              count: composed.mergedIds.length + 1
                          })
                      return composed
                  }
              )
            : await this.repo.nextQueuedInboundForScope(channelId, scopeKey)
        if (!row) return
        const event = parseStoredInboundEvent(row.eventJson)
        if (!event) {
            await this.repo.updateDelivery(row.id, {
                status: 'dropped',
                errorMessage: 'invalid_event_json'
            })
            return
        }
        const channel = await this.repo.getById(channelId)
        if (!channel || channel.status !== 'active') return
        // The observer terminal fires before insertStreamEvent releases the
        // session turn slot, so give the release a moment; losing anyway is
        // fine — handleInbound's conflict branch requeues and the sweep retries.
        for (
            let i = 0;
            i < INFLIGHT_DRAIN_POLL_MAX &&
            (await this.chat.hasInflightTurn(chatSessionId));
            i += 1
        )
            await new Promise((resolve) =>
                setTimeout(resolve, INFLIGHT_DRAIN_POLL_MS)
            )
        await this.handleInbound(channel, event, {
            delivery: row,
            created: true
        }).catch((err) =>
            this.logger.error(
                `queued inbound drain failed delivery=${row.id}: ${(err as Error).message}`
            )
        )
    }

    private async sendSlashReply(
        ctx: ChannelContext,
        provider: ChannelProvider,
        scopeKey: string,
        result: { replyText: string; view?: ChannelCommandView },
        interactionRef?: string
    ): Promise<void> {
        // A command-view reply cannot be routed to a slash response_url, so only
        // use it when there is no interaction ref to honor.
        if (
            !interactionRef &&
            result.view &&
            typeof provider.sendCommandView === 'function'
        ) {
            try {
                await provider.sendCommandView(ctx, scopeKey, result.view)
                return
            } catch (err) {
                this.logger.warn(
                    `command view send failed for channel=${ctx.channel.id}, falling back to text: ${(err as Error).message}`
                )
            }
        }
        await provider
            .sendText(ctx, scopeKey, result.replyText, {
                nonConversational: true,
                interactionRef
            })
            .catch((err) =>
                this.logger.warn(
                    `failed to send slash reply for channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            )
    }

    // Fetch recent channel history (mention-gated chatter the agent never
    // saw) for this turn's background block, attachments included. The
    // provider owns the fetch and fails open; a null return or a throw means
    // the turn proceeds with the original text alone. Persisting the block
    // into the user message is what lets the provider's scan stop at its last
    // reply — everything older is already in-transcript.
    private async fetchHistoryForBackfill(
        channel: ChannelRow,
        ctx: ChannelContext,
        provider: ChannelProvider,
        event: NormalizedInboundEvent,
        scopeKey: string
    ): Promise<ChannelHistoryContext | null> {
        if (event.chatType !== 'group') return null
        if (
            (ctx.config as { historyBackfill?: boolean }).historyBackfill ===
            false
        )
            return null
        if (typeof provider.fetchHistoryContext !== 'function') return null
        try {
            const limit = parseHistoryBackfillLimit(
                (ctx.config as { historyBackfillLimit?: number })
                    .historyBackfillLimit
            )
            const history = await provider.fetchHistoryContext(ctx, event, {
                scopeKey,
                limit
            })
            if (!history || history.text.length === 0) return null
            this.telemetry.event('channel.inbound.backfilled', {
                channelId: channel.id,
                chars: history.text.length,
                attachments: history.attachments?.length ?? 0
            })
            return history
        } catch (err) {
            this.logger.warn(
                `history backfill failed for channel=${channel.id}: ${(err as Error).message}`
            )
            return null
        }
    }

    // Bounded selection of history attachments for materialization: dedupe by
    // URL against the triggering message's own attachments and among
    // themselves, then keep the first HISTORY_ATTACHMENT_MAX_COUNT in the
    // provider's priority order (thread starter first, then newest-first).
    // Everything else keeps its text label and is later marked unavailable.
    private selectHistoryAttachments(
        channel: ChannelRow,
        event: NormalizedInboundEvent,
        attachments: ChannelHistoryAttachment[]
    ): ChannelHistoryAttachment[] {
        if (attachments.length === 0) return []
        const seen = new Set((event.attachments ?? []).map((a) => a.url))
        const selected: ChannelHistoryAttachment[] = []
        for (const att of attachments) {
            if (seen.has(att.url)) continue
            seen.add(att.url)
            if (selected.length >= HISTORY_ATTACHMENT_MAX_COUNT) {
                this.telemetry.event('channel.inbound.attachment_skipped', {
                    channelId: channel.id,
                    providerEventId: event.providerEventId,
                    reason: 'over_history_count',
                    sourceMessageId: att.providerMessageId ?? null,
                    contentType: att.contentType ?? null,
                    size: att.size ?? null
                })
                continue
            }
            selected.push(att)
        }
        return selected
    }

    private createOutboundObserver(opts: {
        channel: ChannelRow
        ctx: ChannelContext
        provider: ChannelProvider
        scopeKey: string
        chatSessionId: string
        channelSessionId: string
        typing?: TypingHolder
        replyToProviderMessageId?: string | null
        inboundMessageId?: string | null
        // Agent-managed reply: never post from Manyfold — no preview and no
        // finalize delivery; the terminal event only resolves the wait and
        // drains the queue.
        suppressDelivery?: boolean
    }): {
        observer: ChatTurnObserver
        startPreview: () => Promise<void>
        wait: (
            assistantMessageId: string,
            pendingDeliveryId: bigint | null
        ) => Promise<void>
    } {
        const { channel, ctx, provider, scopeKey, chatSessionId } = opts
        const mode = this.progressModeFor(ctx.config)
        const useCards =
            (mode === 'preview' || mode === 'activity') &&
            typeof provider.sendPreviewStart === 'function'
        const showActivity = mode === 'activity' && useCards
        // Providers that project progress as platform entities instead of an
        // edited preview message. Agent-managed replies suppress every outbound
        // of ours, progress included.
        const tapEnabled =
            typeof provider.onTurnEvent === 'function' &&
            mode !== 'final' &&
            opts.suppressDelivery !== true
        // Serialized: the projections of one turn must reach the platform in the
        // order they happened, and the terminal reply must come last. Every link
        // catches, so the chain never rejects and never stalls the turn.
        let tapChain: Promise<void> = Promise.resolve()
        let preview: PreviewHandle | null = null
        let buffered = ''
        // Activity lines live outside `buffered` so every finalize path keeps
        // emitting pure final text without knowing about progress rendering.
        const activityLines: string[] = []
        let thinkingBuffer = ''
        let lastFlushed = ''
        let lastFlushedAt = 0
        const previewThrottleMs =
            provider.previewUpdateMinIntervalMs ?? PREVIEW_THROTTLE_MS
        let previewStrikes = 0
        let previewDisabled = false
        // Single-flight with latest-wins: never two concurrent edits of the
        // same preview message; updates arriving mid-edit coalesce into one
        // trailing flush of the newest buffered text.
        let previewFlushing = false
        let previewFlushQueued = false
        // HUD aggregation: usage/tool_call events reach the observer in every
        // progress mode, so we can summarize the turn for the reply footer
        // regardless of preview/activity rendering.
        const hud: ReplyHudStats = {
            model: null,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
            durationMs: null,
            toolCalls: 0
        }
        let assistantMessageId: string | null = null
        let pendingDeliveryId: bigint | null = null
        let suspended = false
        let terminal:
            | { type: 'done' }
            | { type: 'error'; errorMessage: string; cancelled: boolean }
            | null = null
        let finalizing: Promise<void> | null = null
        let resolveWait: (() => void) | null = null
        const flushPreview = async (force: boolean): Promise<void> => {
            if (!preview || !provider.updatePreview || previewDisabled) return
            if (previewFlushing) {
                previewFlushQueued = true
                return
            }
            const body = showActivity
                ? composeActivityPreview(activityLines, buffered)
                : buffered
            const now = Date.now()
            if (
                !force &&
                body === lastFlushed &&
                now - lastFlushedAt < previewThrottleMs
            )
                return
            if (now - lastFlushedAt < previewThrottleMs && !force) return
            if (body === lastFlushed) return
            lastFlushed = body
            lastFlushedAt = now
            previewFlushing = true
            try {
                await provider.updatePreview(ctx, preview, body)
                previewStrikes = 0
            } catch (err) {
                this.logger.warn(
                    `preview update failed for channel=${channel.id}: ${(err as Error).message}`
                )
                this.telemetry.error(
                    'channel.preview.update_failed',
                    err as Error,
                    {
                        channelId: channel.id,
                        provider: provider.name
                    }
                )
                previewStrikes += 1
                if (previewStrikes >= PREVIEW_STRIKE_LIMIT) {
                    previewDisabled = true
                    this.telemetry.event('channel.preview.disabled', {
                        channelId: channel.id,
                        provider: provider.name,
                        strikes: previewStrikes
                    })
                }
            } finally {
                previewFlushing = false
                if (previewFlushQueued) {
                    previewFlushQueued = false
                    void flushPreview(false)
                }
            }
        }

        const settled = new Promise<void>((resolve) => {
            resolveWait = resolve
        })
        const maybeFinalize = (): void => {
            if (!terminal || !assistantMessageId || finalizing) return
            // Both are mutable and the finalize call is now deferred behind the
            // fence, so pin the narrowed values the guard just proved.
            const settledTerminal = terminal
            const turnMessageId = assistantMessageId
            // Let the queued projections drain before the terminal reply: on a
            // platform that derives conversation state from the last thing it
            // received, an action landing after the reply would reopen a closed
            // session. `terminal` is already set, so nothing new joins the
            // chain. The cap bounds the worst case — each link is already
            // bounded by the provider HTTP timeout, so it should never bite.
            const fence = tapEnabled
                ? Promise.race([tapChain, sleep(TAP_FENCE_MAX_MS)])
                : null
            const runFinalize = (
                finalize: () => Promise<void>
            ): Promise<void> => (fence ? fence.then(finalize) : finalize())
            if (opts.suppressDelivery) {
                finalizing = Promise.resolve()
            } else if (settledTerminal.type === 'done') {
                finalizing = runFinalize(() =>
                    this.finalizeSuccess({
                        channel,
                        ctx,
                        provider,
                        scopeKey,
                        chatSessionId,
                        channelSessionId: opts.channelSessionId,
                        assistantMessageId: turnMessageId,
                        pendingDeliveryId,
                        preview,
                        text: buffered.trim(),
                        replyToProviderMessageId: opts.replyToProviderMessageId,
                        inboundMessageId: opts.inboundMessageId,
                        hud
                    })
                )
            } else {
                finalizing = runFinalize(() =>
                    this.finalizeFailure({
                        channel,
                        ctx,
                        provider,
                        scopeKey,
                        chatSessionId,
                        channelSessionId: opts.channelSessionId,
                        assistantMessageId: turnMessageId,
                        pendingDeliveryId,
                        preview,
                        errorMessage: settledTerminal.errorMessage,
                        cancelled: settledTerminal.cancelled,
                        text: buffered.trim(),
                        inboundMessageId: opts.inboundMessageId
                    })
                )
            }
            finalizing
                .catch((err) =>
                    this.logger.error(
                        `channel outbound finalize failed: ${(err as Error).message}`
                    )
                )
                .finally(() => {
                    resolveWait?.()
                    void this.drainQueuedInbound(
                        channel.id,
                        scopeKey,
                        chatSessionId
                    ).catch((err) =>
                        this.logger.warn(
                            `queued inbound drain failed for channel=${channel.id}: ${(err as Error).message}`
                        )
                    )
                })
        }
        const observer: ChatTurnObserver = (event) => {
            if (terminal || suspended) return
            // Ahead of the type-specific branches below: most of them return
            // early, and tool_result has no branch at all, so anything placed
            // after them would never see the full event stream.
            if (
                tapEnabled &&
                (event.type === 'tool_call' ||
                    event.type === 'tool_result' ||
                    event.type === 'thinking')
            ) {
                const tapEvent = event
                tapChain = tapChain
                    .then(() =>
                        provider.onTurnEvent?.(ctx, scopeKey, tapEvent, {
                            chatSessionId,
                            channelSessionId: opts.channelSessionId
                        })
                    )
                    .then(() => undefined)
                    .catch((err) => {
                        this.logger.debug(
                            `turn tap failed for channel=${channel.id}: ${(err as Error).message}`
                        )
                    })
            }
            if (event.type === 'token') {
                buffered += event.text
                void flushPreview(false)
                return
            }
            // Output moderation supersedes the whole answer. Preview edits are
            // still in flight, so overwrite the buffer and repaint rather than
            // letting the superseded text be what gets delivered.
            if (event.type === 'replace') {
                buffered = event.text
                void flushPreview(false)
                return
            }
            if (event.type === 'usage') {
                if (event.usage.model) hud.model = event.usage.model
                hud.inputTokens += event.usage.inputTokens ?? 0
                hud.outputTokens += event.usage.outputTokens ?? 0
                if (
                    event.usage.costUsd !== null &&
                    event.usage.costUsd !== undefined
                )
                    hud.costUsd = (hud.costUsd ?? 0) + event.usage.costUsd
                if (
                    event.usage.totalMs !== null &&
                    event.usage.totalMs !== undefined
                )
                    hud.durationMs = event.usage.totalMs
                return
            }
            if (event.type === 'tool_call') {
                // Count in every mode (before the activity-render gate) so the
                // HUD footer reflects tool usage even without activity preview.
                hud.toolCalls += 1
                if (!showActivity) return
                thinkingBuffer = ''
                pushActivityLine(
                    activityLines,
                    `⚙ ${event.toolName} ${summarizeToolArgs(event.args)}`
                )
                void flushPreview(false)
                return
            }
            if (event.type === 'thinking') {
                if (!showActivity) return
                thinkingBuffer += event.text
                setThinkingLine(activityLines, thinkingBuffer)
                void flushPreview(false)
                return
            }
            if (event.type === 'done') {
                opts.typing?.end()
                terminal = { type: 'done' }
                maybeFinalize()
                return
            }
            if (event.type === 'error') {
                opts.typing?.end()
                const cancelled =
                    event.error.code === 'cancelled' ||
                    event.error.code === 'cancelled_by_user'
                terminal = {
                    type: 'error',
                    errorMessage: event.error.message,
                    cancelled
                }
                maybeFinalize()
                return
            }
            if (event.type === 'suspended') {
                // The turn continues on a daemon and terminates through
                // resumeAssistantTurn, which cannot carry this observer. Stop
                // waiting; the pending outbox row stays behind and the
                // reconcile sweep delivers the eventual reply.
                opts.typing?.end()
                suspended = true
                resolveWait?.()
            }
        }

        return {
            observer,
            startPreview: async (): Promise<void> => {
                if (!useCards || opts.suppressDelivery) return
                try {
                    preview =
                        (await provider.sendPreviewStart?.(ctx, scopeKey, {
                            replyToProviderMessageId:
                                opts.replyToProviderMessageId
                        })) ?? null
                    await flushPreview(true)
                } catch (err) {
                    this.logger.warn(
                        `preview start failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                    this.telemetry.error(
                        'channel.preview.start_failed',
                        err as Error,
                        {
                            channelId: channel.id,
                            provider: provider.name
                        }
                    )
                    preview = null
                }
            },
            wait: async (
                messageId: string,
                pendingId: bigint | null
            ): Promise<void> => {
                assistantMessageId = messageId
                pendingDeliveryId = pendingId
                maybeFinalize()
                let capTimer: NodeJS.Timeout | null = null
                const capped = new Promise<void>((resolve) => {
                    capTimer = setTimeout(resolve, REPLY_WAIT_MAX_MS)
                    capTimer.unref?.()
                })
                try {
                    await Promise.race([settled, capped])
                } finally {
                    if (capTimer) clearTimeout(capTimer)
                }
            }
        }
    }

    private async finalizeSuccess(opts: {
        channel: ChannelRow
        ctx: ChannelContext
        provider: ChannelProvider
        scopeKey: string
        chatSessionId: string
        channelSessionId: string
        assistantMessageId: string
        pendingDeliveryId: bigint | null
        preview: PreviewHandle | null
        text: string
        replyToProviderMessageId?: string | null
        inboundMessageId?: string | null
        hud?: ReplyHudStats
    }): Promise<void> {
        const { channel, ctx, provider, scopeKey, preview, text } = opts
        const base = text.length === 0 ? '(empty response)' : text
        // Append the usage footer INSIDE finalText (before the outbox row is
        // written) so a retry re-delivers it too.
        const replyHud =
            (ctx.config as { replyHud?: boolean }).replyHud === true
        const footer = replyHud && opts.hud ? buildReplyHud(opts.hud) : null
        const finalText = footer ? `${base}\n\n${footer}` : base
        // Outbox: flip the reply-expectation row to queued before attempting
        // delivery so a crash or provider failure can be retried by the
        // outbound sweep. The enqueue grace keeps the sweeper away while this
        // inline send runs. Losing the CAS means the reconcile sweep already
        // took the reply over — do not double-send.
        const queuedPatch = {
            eventJson: { text: finalText, terminal: 'final' as const },
            summaryText: truncate(finalText, SUMMARY_MAX_LEN),
            status: 'queued' as const,
            errorMessage: null,
            // The inline send starts immediately below; stamping the attempt
            // in the same write means a crash mid-send leaves the row marked
            // unknown-outcome for the sweep to reconcile instead of blind-retry.
            sendAttemptStartedAt: new Date(),
            nextAttemptAt: new Date(Date.now() + OUTBOUND_ENQUEUE_GRACE_MS)
        }
        let queued: ChannelDeliveryRow | null
        if (opts.pendingDeliveryId !== null) {
            queued = await this.repo.resolvePendingDelivery(
                opts.pendingDeliveryId,
                queuedPatch
            )
            if (!queued) return
        } else {
            queued = await this.repo.insertDelivery({
                channelId: channel.id,
                chatSessionId: opts.chatSessionId,
                chatMessageId: opts.assistantMessageId,
                direction: 'outbound',
                scopeKey,
                providerEventId: null,
                providerMessageId: null,
                ...queuedPatch,
                createdAt: new Date()
            })
        }
        const finalMessageMode =
            (ctx.config as { finalMessageMode?: ChannelFinalMessageMode })
                .finalMessageMode ?? 'edit'
        let providerMessageId: string | undefined
        try {
            let previewDropped = false
            // Fresh mode: delete the streaming preview and post the final reply
            // as a new message so the platform fires a push notification. If the
            // delete fails, fall through to editing the preview in place.
            if (
                preview &&
                finalMessageMode === 'fresh' &&
                provider.deleteMessage
            ) {
                try {
                    await provider.deleteMessage(
                        ctx,
                        scopeKey,
                        preview.providerMessageId
                    )
                    previewDropped = true
                } catch (delErr) {
                    this.logger.warn(
                        `preview delete failed for channel=${channel.id}, editing in place: ${(delErr as Error).message}`
                    )
                }
            }
            if (preview && !previewDropped && provider.finishPreview) {
                await provider.finishPreview(ctx, preview, finalText)
                providerMessageId = preview.providerMessageId
            } else {
                const sent = await provider.sendText(ctx, scopeKey, finalText, {
                    replyToProviderMessageId: opts.replyToProviderMessageId,
                    terminal: 'final'
                })
                providerMessageId = sent.providerMessageId
            }
        } catch (err) {
            this.logger.error(
                `outbound send failed for channel=${channel.id}: ${(err as Error).message}`
            )
            const classified = classifySendError(err)
            const permanent = isPermanentSendErrorKind(classified.kind)
            await this.repo.updateDelivery(queued.id, {
                status: permanent ? 'dead' : 'failed',
                errorMessage: (err as Error).message,
                attemptCount: 1,
                sendAttemptStartedAt: null,
                nextAttemptAt: permanent
                    ? null
                    : new Date(
                          Date.now() +
                              sendRetryDelayMs(
                                  classified,
                                  0,
                                  OUTBOUND_RETRY_BACKOFF_MS
                              )
                      )
            })
            this.telemetry.error('channel.delivery.failed', err as Error, {
                channelId: channel.id,
                chatSessionId: opts.chatSessionId,
                errorKind: classified.kind
            })
            return
        }
        await this.repo.touchSessionOutbound(opts.channelSessionId, new Date())
        await this.repo.updateDelivery(queued.id, {
            status: 'sent',
            providerMessageId: providerMessageId ?? null,
            errorMessage: null,
            attemptCount: 1,
            sendAttemptStartedAt: null,
            nextAttemptAt: null
        })
        this.setAckReaction(
            ctx,
            provider,
            scopeKey,
            opts.inboundMessageId,
            'done'
        )
        this.telemetry.event('channel.delivery.sent', {
            channelId: channel.id,
            chatSessionId: opts.chatSessionId
        })
        await this.maybeSendOutboundFiles({
            channel,
            ctx,
            provider,
            scopeKey,
            assistantMessageId: opts.assistantMessageId,
            text: opts.text
        })
    }

    // Attach files the agent referenced in its reply (e.g. a generated chart).
    // Best-effort follow-up after the text reply lands: failures degrade to the
    // text-only reply the user already has.
    private async maybeSendOutboundFiles(opts: {
        channel: ChannelRow
        ctx: ChannelContext
        provider: ChannelProvider
        scopeKey: string
        assistantMessageId: string
        text: string
    }): Promise<void> {
        const { channel, ctx, provider, scopeKey } = opts
        if (typeof provider.sendAttachments !== 'function') return
        if ((ctx.config as { outboundFiles?: boolean }).outboundFiles === false)
            return
        const refs = extractWorkspaceFileRefs(opts.text)
        if (refs.length === 0) return
        let files: OutboundFile[]
        try {
            files = await this.apiFiles.readWorkspaceFiles(
                channel.agentId,
                refs
            )
        } catch (err) {
            this.logger.warn(
                `outbound file read failed for channel=${channel.id}: ${(err as Error).message}`
            )
            this.telemetry.event('channel.attachments.failed', {
                channelId: channel.id,
                reason: 'read_failed'
            })
            return
        }
        if (files.length === 0) return
        try {
            await provider.sendAttachments(
                ctx,
                scopeKey,
                files.map((file) => ({
                    name: file.name,
                    contentType: file.contentType,
                    bytes: file.bytes
                }))
            )
            await this.chat.appendAssistantAttachments(
                opts.assistantMessageId,
                files.map((file) => ({
                    type: 'attachment' as const,
                    name: file.name,
                    path: file.relPath,
                    rootId: 'workspace',
                    contentType: file.contentType,
                    size: file.bytes.length
                }))
            )
            this.telemetry.event('channel.attachments.sent', {
                channelId: channel.id,
                count: files.length
            })
        } catch (err) {
            this.logger.warn(
                `outbound file send failed for channel=${channel.id}: ${(err as Error).message}`
            )
            this.telemetry.event('channel.attachments.failed', {
                channelId: channel.id,
                reason: 'send_failed'
            })
        }
    }

    private async finalizeFailure(opts: {
        channel: ChannelRow
        ctx: ChannelContext
        provider: ChannelProvider
        scopeKey: string
        chatSessionId: string
        channelSessionId: string
        assistantMessageId: string
        pendingDeliveryId: bigint | null
        preview: PreviewHandle | null
        errorMessage: string
        cancelled: boolean
        text: string
        inboundMessageId?: string | null
    }): Promise<void> {
        const { channel, ctx, provider, scopeKey, preview, cancelled } = opts
        const replyText = cancelled
            ? opts.text.length > 0
                ? `${opts.text}\n\n${STOPPED_MARKER}`
                : '[response cancelled]'
            : `[agent failed: ${truncate(opts.errorMessage, ERROR_REPLY_MAX_LEN)}]`
        // Failure notes are best-effort and never retried (no nextAttemptAt),
        // but the pending row must still be resolved so the reconcile sweep
        // does not deliver a second note; losing the CAS means it already did.
        const record = {
            summaryText: truncate(replyText, SUMMARY_MAX_LEN),
            status: (cancelled ? 'dropped' : 'failed') as 'dropped' | 'failed',
            errorMessage: opts.errorMessage,
            nextAttemptAt: null
        }
        if (opts.pendingDeliveryId !== null) {
            const resolved = await this.repo.resolvePendingDelivery(
                opts.pendingDeliveryId,
                record
            )
            if (!resolved) return
        } else {
            await this.repo.insertDelivery({
                channelId: channel.id,
                chatSessionId: opts.chatSessionId,
                chatMessageId: opts.assistantMessageId,
                direction: 'outbound',
                scopeKey,
                providerEventId: null,
                providerMessageId: null,
                ...record,
                createdAt: new Date()
            })
        }
        try {
            if (preview && provider.finishPreview) {
                await provider.finishPreview(ctx, preview, replyText)
            } else {
                await provider.sendText(ctx, scopeKey, replyText, {
                    terminal: cancelled ? 'cancelled' : 'error'
                })
            }
        } catch (err) {
            this.logger.warn(
                `failure reply send failed for channel=${channel.id}: ${(err as Error).message}`
            )
        }
        this.setAckReaction(
            ctx,
            provider,
            scopeKey,
            opts.inboundMessageId,
            cancelled ? 'done' : 'failed'
        )
        this.telemetry.event('channel.delivery.failed', {
            channelId: channel.id,
            chatSessionId: opts.chatSessionId,
            cancelled,
            errorMessage: cancelled
                ? null
                : truncate(opts.errorMessage, ERROR_REPLY_MAX_LEN)
        })
    }

    private shouldRespond(
        event: NormalizedInboundEvent,
        config: ChannelConfig
    ): boolean {
        if (event.chatType !== 'group') return true
        const mentionOnly = (config as { mentionOnly?: boolean }).mentionOnly
        if (mentionOnly === false) return true
        return event.isMention
    }

    private async maybeAutoResetOnIdle(
        channel: ChannelRow,
        ctx: ChannelContext,
        resolved: ResolvedSession,
        scopeName: string | null,
        event: NormalizedInboundEvent
    ): Promise<ResolvedSession | null> {
        if (resolved.isNew) return null
        const mins = (ctx.config as { resetOnIdleMins?: number | null })
            .resetOnIdleMins
        const session = resolved.session
        const last = mostRecentDate(
            session.lastInboundAt,
            session.lastOutboundAt,
            session.updatedAt
        )
        if (!shouldAutoResetOnIdle(mins ?? null, last)) return null
        return this.router.fork(channel, session.scopeKey, {
            scopeName,
            remoteUserId: event.senderId,
            remoteThreadId: event.threadId ?? null
        })
    }

    // Reaction-as-status on the triggering message (working -> done/failed),
    // fire-and-forget: reactions are affordance, never worth failing or
    // delaying the reply for. Cancelled turns count as done — the user asked
    // for the stop. MF_CHANNEL_ACK_REACTIONS=0 disables globally.
    private setAckReaction(
        ctx: ChannelContext,
        provider: ChannelProvider,
        scopeKey: string,
        providerMessageId: string | null | undefined,
        state: 'working' | 'done' | 'failed'
    ): void {
        if (process.env.MF_CHANNEL_ACK_REACTIONS === '0') return
        if (!providerMessageId) return
        if (typeof provider.setInboundReaction !== 'function') return
        void provider
            .setInboundReaction(ctx, scopeKey, providerMessageId, state)
            .catch((err) =>
                this.logger.debug(
                    `ack reaction ${state} failed for channel=${ctx.channel.id}: ${(err as Error).message}`
                )
            )
    }

    private decryptCredentials(channel: ChannelRow): ChannelCredentials | null {
        if (!channel.credentialsCiphertext) return null
        try {
            const plain = this.crypto.decrypt({
                ciphertext: channel.credentialsCiphertext,
                keyVersion: channel.keyVersion
            })
            return JSON.parse(plain) as ChannelCredentials
        } catch (err) {
            this.logger.error(
                `failed to decrypt credentials for channel=${channel.id}: ${(err as Error).message}`
            )
            return null
        }
    }

    progressModeFor(_config: ChannelConfig): ChannelProgressMode {
        return (
            ((_config as { progressMode?: ChannelProgressMode })
                .progressMode as ChannelProgressMode | undefined) ?? 'preview'
        )
    }

    async replayRecoverableInboundEvents(limit = 100): Promise<number> {
        if (this.replaying) return 0
        this.replaying = true
        try {
            const deliveries = await this.repo.listRecoverableInboundEvents(
                new Date(Date.now() - INBOUND_PROCESSING_STALE_MS),
                limit
            )
            let processed = 0
            // Sequential on purpose: a replayed event runs a full agent turn,
            // so a concurrent batch would stampede providers and the LLM.
            // Unclaimed rows simply surface again on the next sweep tick.
            for (const delivery of deliveries) {
                const event = parseStoredInboundEvent(delivery.eventJson)
                if (!event) {
                    await this.repo.updateDelivery(delivery.id, {
                        status: 'dropped',
                        errorMessage: 'invalid_event_json'
                    })
                    continue
                }
                const channel = await this.repo.getById(delivery.channelId)
                if (!channel || channel.status !== 'active') continue
                processed += 1
                await this.handleInbound(channel, event, {
                    delivery,
                    created: true
                }).catch((err) => {
                    this.logger.error(
                        `recoverable inbound replay failed delivery=${delivery.id}: ${(err as Error).message}`
                    )
                })
            }
            if (processed > 0)
                this.logger.log(
                    `replayed ${processed} recoverable inbound event(s)`
                )
            return processed
        } finally {
            this.replaying = false
        }
    }

    async sweepOutboundDeliveries(limit = 50): Promise<number> {
        if (this.sweepingOutbound) return 0
        this.sweepingOutbound = true
        try {
            const staleBefore = new Date(
                Date.now() - INBOUND_PROCESSING_STALE_MS
            )
            const due = await this.repo.listDueOutboundDeliveries(
                staleBefore,
                limit
            )
            let delivered = 0
            for (const row of due) {
                const claimed = await this.repo.claimOutboundDelivery(
                    row.id,
                    staleBefore
                )
                if (!claimed) continue
                const channel = await this.repo.getById(claimed.channelId)
                if (!channel) {
                    await this.repo.updateDelivery(claimed.id, {
                        status: 'dead',
                        errorMessage: 'channel_missing'
                    })
                    continue
                }
                if (channel.status !== 'active') {
                    await this.repo.updateDelivery(claimed.id, {
                        status: 'failed',
                        errorMessage: 'channel_inactive',
                        nextAttemptAt: new Date(
                            Date.now() + OUTBOUND_INACTIVE_RETRY_MS
                        )
                    })
                    continue
                }
                const text = (claimed.eventJson as { text?: unknown } | null)
                    ?.text
                const storedFiles = parseStoredSendFiles(claimed.eventJson)
                const storedTerminal = parseStoredTerminal(claimed.eventJson)
                if (
                    !storedFiles &&
                    (typeof text !== 'string' || text.length === 0)
                ) {
                    await this.repo.updateDelivery(claimed.id, {
                        status: 'dead',
                        errorMessage: 'missing_text'
                    })
                    continue
                }
                try {
                    const ctx = this.buildContext(channel)
                    const provider = this.providers.get(channel.provider)
                    // Agent-send rows carry an explicit target; their synthetic
                    // scopeKey must never reach sendText's scope parsing.
                    const target = parseStoredSendTarget(claimed.eventJson)
                    if (storedFiles && !target) {
                        await this.repo.updateDelivery(claimed.id, {
                            status: 'dead',
                            errorMessage: 'missing_target'
                        })
                        continue
                    }
                    const unsupported = storedFiles
                        ? typeof provider.sendDirectAttachments !== 'function'
                        : target && typeof provider.sendDirect !== 'function'
                    if (unsupported) {
                        await this.repo.updateDelivery(claimed.id, {
                            status: 'dead',
                            errorMessage: 'provider_unsupported'
                        })
                        continue
                    }
                    // A row still stamped with a send attempt was interrupted
                    // mid-send: the platform may already have the message, so
                    // check before re-sending instead of blindly duplicating.
                    // File rows have no text baseline to reconcile against, so
                    // they retry with the duplicate risk on record.
                    if (claimed.sendAttemptStartedAt && !storedFiles) {
                        const verdict = await this.reconcileUnknownSend({
                            ctx,
                            provider,
                            claimed,
                            target,
                            text: text as string
                        })
                        if (verdict.outcome === 'sent') {
                            await this.repo.updateDelivery(claimed.id, {
                                status: 'sent',
                                providerMessageId:
                                    verdict.providerMessageId ?? null,
                                errorMessage: null,
                                attemptCount: claimed.attemptCount + 1,
                                sendAttemptStartedAt: null,
                                nextAttemptAt: null
                            })
                            delivered += 1
                            this.telemetry.event(
                                'channel.delivery.reconciled_sent',
                                {
                                    channelId: channel.id,
                                    chatSessionId: claimed.chatSessionId
                                }
                            )
                            continue
                        }
                        if (verdict.outcome === 'unknown')
                            this.telemetry.event(
                                'channel.delivery.unknown_send_retry',
                                {
                                    channelId: channel.id,
                                    chatSessionId: claimed.chatSessionId,
                                    provider: channel.provider
                                }
                            )
                    } else if (claimed.sendAttemptStartedAt && storedFiles) {
                        this.telemetry.event(
                            'channel.delivery.unknown_send_retry',
                            {
                                channelId: channel.id,
                                chatSessionId: claimed.chatSessionId,
                                provider: channel.provider
                            }
                        )
                    }
                    await this.repo.updateDelivery(claimed.id, {
                        sendAttemptStartedAt: new Date()
                    })
                    const sent =
                        storedFiles && target
                            ? await this.deliverAgentFiles(
                                  channel,
                                  ctx,
                                  provider,
                                  target,
                                  storedFiles
                              )
                            : target && provider.sendDirect
                              ? await provider.sendDirect(
                                    ctx,
                                    target,
                                    text as string
                                )
                              : await provider.sendText(
                                    ctx,
                                    claimed.scopeKey,
                                    text as string,
                                    { terminal: storedTerminal }
                                )
                    await this.repo.updateDelivery(claimed.id, {
                        status: 'sent',
                        providerMessageId: sent.providerMessageId ?? null,
                        errorMessage: null,
                        attemptCount: claimed.attemptCount + 1,
                        sendAttemptStartedAt: null,
                        nextAttemptAt: null
                    })
                    delivered += 1
                    this.telemetry.event('channel.delivery.retried', {
                        channelId: channel.id,
                        chatSessionId: claimed.chatSessionId
                    })
                } catch (err) {
                    const classified = classifySendError(err)
                    const attempts = claimed.attemptCount + 1
                    const exhausted =
                        attempts >= OUTBOUND_MAX_ATTEMPTS ||
                        isPermanentSendErrorKind(classified.kind)
                    await this.repo.updateDelivery(claimed.id, {
                        status: exhausted ? 'dead' : 'failed',
                        attemptCount: attempts,
                        errorMessage: (err as Error).message,
                        sendAttemptStartedAt: null,
                        nextAttemptAt: exhausted
                            ? null
                            : new Date(
                                  Date.now() +
                                      sendRetryDelayMs(
                                          classified,
                                          attempts - 1,
                                          OUTBOUND_RETRY_BACKOFF_MS
                                      )
                              )
                    })
                    this.telemetry.error(
                        'channel.delivery.retry_failed',
                        err as Error,
                        {
                            channelId: channel.id,
                            chatSessionId: claimed.chatSessionId,
                            errorKind: classified.kind
                        }
                    )
                }
            }
            if (delivered > 0)
                this.logger.log(`re-delivered ${delivered} outbound message(s)`)
            return delivered
        } finally {
            this.sweepingOutbound = false
        }
    }

    // Providers without reconcileSend accept the duplicate risk: the sweep
    // retries and telemetry records that the outcome was unknown.
    private async reconcileUnknownSend(opts: {
        ctx: ChannelContext
        provider: ChannelProvider
        claimed: ChannelDeliveryRow
        target: ChannelSendTarget | null
        text: string
    }): Promise<{
        outcome: 'sent' | 'not_sent' | 'unknown'
        providerMessageId?: string
    }> {
        const { provider, claimed } = opts
        if (
            typeof provider.reconcileSend !== 'function' ||
            !claimed.sendAttemptStartedAt
        )
            return { outcome: 'unknown' }
        try {
            return await provider.reconcileSend(opts.ctx, {
                scopeKey: claimed.scopeKey,
                target: opts.target,
                text: opts.text,
                attemptStartedAt: claimed.sendAttemptStartedAt
            })
        } catch (err) {
            this.logger.warn(
                `reconcileSend failed for channel=${claimed.channelId}: ${(err as Error).message}`
            )
            return { outcome: 'unknown' }
        }
    }

    // Deliver replies whose in-memory observer never finalized: crash or
    // deploy mid-turn, daemon suspend/resume (the resume carries no observer),
    // or a stream that hung past the wait cap. The persisted turn state is the
    // source of truth; resolved rows are queued for the outbound sweep.
    async reconcilePendingReplies(limit = 50): Promise<number> {
        if (this.reconcilingPending) return 0
        this.reconcilingPending = true
        try {
            const rows = await this.repo.listStalePendingOutbound(
                new Date(Date.now() - PENDING_REPLY_MIN_AGE_MS),
                limit
            )
            let reconciled = 0
            for (const row of rows) {
                const outcome = row.chatMessageId
                    ? await this.chat.getTurnOutcome(row.chatMessageId)
                    : ({ state: 'missing' } as const)
                if (outcome.state === 'missing') {
                    await this.repo
                        .resolvePendingDelivery(row.id, {
                            status: 'dead',
                            errorMessage: 'assistant_message_missing'
                        })
                        .catch(() => null)
                    continue
                }
                if (outcome.state === 'running') {
                    if (
                        row.updatedAt.getTime() >
                        Date.now() - PENDING_REPLY_MAX_TURN_MS
                    )
                        continue
                }
                const text =
                    outcome.state === 'done'
                        ? outcome.text.trim().length > 0
                            ? outcome.text.trim()
                            : '(empty response)'
                        : outcome.state === 'error' && outcome.cancelled
                          ? '[response cancelled]'
                          : `[agent failed: ${truncate(
                                outcome.state === 'error'
                                    ? outcome.errorMessage
                                    : 'turn did not complete',
                                ERROR_REPLY_MAX_LEN
                            )}]`
                // The terminal disposition is only knowable here for a turn the
                // inline path never got to finalize; persist it so the sweep's
                // send carries it (Linear maps it to the activity type).
                const terminal =
                    outcome.state === 'done'
                        ? ('final' as const)
                        : outcome.state === 'error' && outcome.cancelled
                          ? ('cancelled' as const)
                          : ('error' as const)
                const taken = await this.repo.resolvePendingDelivery(row.id, {
                    status: 'queued',
                    eventJson: { text, terminal },
                    summaryText: truncate(text, SUMMARY_MAX_LEN),
                    errorMessage:
                        outcome.state === 'error'
                            ? outcome.errorMessage
                            : outcome.state === 'running'
                              ? 'turn_never_terminated'
                              : null,
                    nextAttemptAt: new Date()
                })
                if (!taken) continue
                reconciled += 1
                this.telemetry.event('channel.delivery.reconciled', {
                    channelId: row.channelId,
                    chatSessionId: row.chatSessionId,
                    outcome: outcome.state
                })
            }
            if (reconciled > 0)
                this.logger.log(
                    `reconciled ${reconciled} pending channel repl(ies)`
                )
            return reconciled
        } finally {
            this.reconcilingPending = false
        }
    }

    // Materializes inbound attachment descriptors for the agent: download each
    // URL, then hand the bytes to ChatApiFileService (workspace files for CLI
    // agents, upload store for dify). Per-file problems skip that file only;
    // systemic problems degrade the turn to text-only. Never throws — a broken
    // attachment must not fail the whole message.
    // Downloads and ingests the triggering event's attachments plus a bounded
    // set of history-backfill attachments in ONE batch (one ingest call, one
    // workspace batch dir). The trigger's descriptors are placed first so they
    // always win the shared count/size caps. `degraded` reports the trigger's
    // outcome only — it drives the user-facing ⚠ notice and the empty-turn
    // drop, and a history attachment failure must never surface either.
    // `materializedUrls` lets the caller mark unmaterialized history
    // attachments in the backfill text.
    private async prepareInboundFiles(
        ctx: ChannelContext,
        provider: ChannelProvider,
        event: NormalizedInboundEvent,
        chatSessionId: string,
        historyAttachments: ChannelHistoryAttachment[] = []
    ): Promise<
        IngestedFiles & {
            degraded: AttachmentDegradeReason | false
            materializedUrls: Set<string>
        }
    > {
        const channel = ctx.channel
        const triggerCount = (event.attachments ?? []).length
        const descriptors: Array<{
            attachment: NormalizedInboundAttachment
            history: boolean
        }> = [
            ...(event.attachments ?? []).map((attachment) => ({
                attachment,
                history: false
            })),
            ...historyAttachments.map((attachment) => ({
                attachment,
                history: true
            }))
        ]
        const none = {
            attachments: [],
            uploads: [],
            materializedUrls: new Set<string>()
        }
        if (descriptors.length === 0) return { ...none, degraded: false }
        const skipped = (
            entry: {
                attachment: NormalizedInboundAttachment
                history: boolean
            },
            reason: string
        ) =>
            this.telemetry.event('channel.inbound.attachment_skipped', {
                channelId: channel.id,
                providerEventId: event.providerEventId,
                reason,
                sourceMessageId: entry.history
                    ? ((entry.attachment as ChannelHistoryAttachment)
                          .providerMessageId ?? null)
                    : null,
                contentType: entry.attachment.contentType ?? null,
                size: entry.attachment.size ?? null
            })
        const triggerDegraded = (reason: AttachmentDegradeReason) =>
            triggerCount > 0 ? reason : (false as const)
        const degraded = (reason: AttachmentDegradeReason, count: number) => {
            this.telemetry.event('channel.inbound.attachments_degraded', {
                channelId: channel.id,
                providerEventId: event.providerEventId,
                reason,
                count
            })
            return { ...none, degraded: triggerDegraded(reason) }
        }
        if (!(await this.apiFiles.supportsAttachments(channel.agentId)))
            return degraded('unsupported_framework', descriptors.length)
        const capped = descriptors.slice(0, CHAT_UPLOAD_MAX_COUNT)
        for (const entry of descriptors.slice(CHAT_UPLOAD_MAX_COUNT))
            skipped(entry, 'over_count')
        const resolved = await Promise.all(
            capped.map(async (entry) => {
                const { attachment } = entry
                if ((attachment.size ?? 0) > CHAT_UPLOAD_MAX_FILE_BYTES) {
                    skipped(entry, 'oversized')
                    return null
                }
                if (
                    !isAllowedChatAttachment({
                        type: attachment.contentType ?? undefined,
                        name: attachment.name
                    })
                ) {
                    skipped(entry, 'unsupported_type')
                    return null
                }
                try {
                    // Prefer the provider's authenticated downloader when it
                    // has one (e.g. Slack url_private needs the bot token); the
                    // anonymous URL fetch cannot reach those. maxBytes is
                    // enforced by both paths.
                    const file =
                        typeof provider.downloadAttachment === 'function'
                            ? await provider.downloadAttachment(
                                  ctx,
                                  attachment,
                                  { maxBytes: CHAT_UPLOAD_MAX_FILE_BYTES }
                              )
                            : await resolveFileInput(
                                  {
                                      kind: 'url',
                                      value: attachment.url,
                                      contentType:
                                          attachment.contentType ?? undefined,
                                      filename: attachment.name
                                  },
                                  CHAT_UPLOAD_MAX_FILE_BYTES
                              )
                    return { entry, file }
                } catch (err) {
                    this.logger.warn(
                        `attachment download failed for channel=${channel.id}: ${(err as Error).message}`
                    )
                    skipped(entry, 'download_failed')
                    return null
                }
            })
        )
        const files: IngestFile[] = []
        const included: typeof descriptors = []
        let total = 0
        for (const item of resolved) {
            if (!item) continue
            if (total + item.file.bytes.length > CHAT_UPLOAD_MAX_TOTAL_BYTES) {
                skipped(item.entry, 'over_total')
                continue
            }
            total += item.file.bytes.length
            files.push(item.file)
            included.push(item.entry)
        }
        if (files.length === 0)
            return {
                ...none,
                degraded: triggerDegraded('attachments_unavailable')
            }
        try {
            const ingested = await this.apiFiles.ingest({
                userId: channel.userId,
                agentId: channel.agentId,
                sessionId: chatSessionId,
                files
            })
            return {
                ...ingested,
                degraded:
                    triggerCount > 0 &&
                    !included.some((entry) => !entry.history)
                        ? 'attachments_unavailable'
                        : false,
                materializedUrls: new Set(
                    included.map((entry) => entry.attachment.url)
                )
            }
        } catch (err) {
            this.logger.warn(
                `attachment ingest failed for channel=${channel.id}: ${(err as Error).message}`
            )
            return degraded('ingest_failed', files.length)
        }
    }

    private recordInboundEvent(
        channelId: string,
        event: NormalizedInboundEvent
    ): Promise<ChannelInboundIntake> {
        const providerEventId = normalizeProviderEventId(event.providerEventId)
        return this.repo.insertInboundEvent({
            channelId,
            providerEventId,
            eventJson: event as unknown as Record<string, unknown>,
            summaryText: truncate(summarizeInbound(event), SUMMARY_MAX_LEN),
            createdAt: new Date()
        })
    }
}

const truncate = (value: string, max: number): string => {
    if (value.length <= max) return value
    return `${value.slice(0, max - 1)}…`
}

// Joins the backfill block and the triggering text, rewriting the label of
// every history attachment that did not materialize (capped, unsupported,
// oversize, download or ingest failure) to its explicit unavailable form so
// the agent never assumes a file it cannot read.
const composeTurnText = (
    event: NormalizedInboundEvent,
    history: ChannelHistoryContext | null,
    materializedUrls: ReadonlySet<string>
): string => {
    if (!history || history.text.length === 0) return event.text
    let text = history.text
    for (const att of history.attachments ?? []) {
        if (materializedUrls.has(att.url)) continue
        text = text.replace(
            historyAttachmentLabel(att),
            historyAttachmentUnavailableLabel(att)
        )
    }
    return `${text}\n\n[New message]\n${event.text}`
}

// unref'd so a pending fence timer can never hold the process open at shutdown.
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        timer.unref?.()
    })

export interface ReplyHudStats {
    model: string | null
    inputTokens: number
    outputTokens: number
    costUsd: number | null
    durationMs: number | null
    toolCalls: number
}

const formatHudTokens = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

export const buildReplyHud = (hud: ReplyHudStats): string => {
    const parts: string[] = []
    if (hud.model) parts.push(hud.model)
    const tokens = hud.inputTokens + hud.outputTokens
    if (tokens > 0) parts.push(`${formatHudTokens(tokens)} tok`)
    if (hud.costUsd !== null)
        parts.push(`$${hud.costUsd.toFixed(hud.costUsd < 1 ? 3 : 2)}`)
    if (hud.durationMs !== null)
        parts.push(`${(hud.durationMs / 1000).toFixed(1)}s`)
    if (hud.toolCalls > 0)
        parts.push(`${hud.toolCalls} tool${hud.toolCalls === 1 ? '' : 's'}`)
    if (parts.length === 0) return ''
    return `⎿ ${parts.join(' · ')}`
}

const summarizeInbound = (event: NormalizedInboundEvent): string => {
    if (event.text.length > 0) return event.text
    const count = event.attachments?.length ?? 0
    if (count === 0) return event.text
    return `[${count} attachment${count === 1 ? '' : 's'}]`
}

// Ties a provider typing indicator to the turn lifecycle without racing it:
// a terminal that lands before startTyping resolves stops the indicator the
// moment it attaches.
interface TypingHolder {
    attach: (stop: () => void) => void
    end: () => void
}

const createTypingHolder = (): TypingHolder => {
    let stop: (() => void) | null = null
    let ended = false
    return {
        attach(next: () => void): void {
            if (ended) next()
            else stop = next
        },
        end(): void {
            ended = true
            stop?.()
            stop = null
        }
    }
}

const ACTIVITY_MAX_LINES = 8
const ACTIVITY_LINE_MAX = 100
// Must sit under every provider's own preview cap (discord's 1966 is the
// tightest): providers head-truncate, and in activity mode the streamed text
// sits at the bottom — provider truncation would eat exactly the wrong part.
const ACTIVITY_PREVIEW_BUDGET = 1500

const clipActivityLine = (line: string): string => {
    const flat = line.replace(/\s+/g, ' ').trim()
    if (flat.length <= ACTIVITY_LINE_MAX) return flat
    return `${flat.slice(0, ACTIVITY_LINE_MAX - 1)}…`
}

export const pushActivityLine = (lines: string[], line: string): void => {
    lines.push(clipActivityLine(line))
    if (lines.length > ACTIVITY_MAX_LINES) lines.shift()
}

// Thinking streams in fragments; render them as ONE evolving line instead of
// a line per fragment. A tool_call resets the buffer so the next thought
// starts fresh.
export const setThinkingLine = (lines: string[], text: string): void => {
    const line = clipActivityLine(`💭 ${text}`)
    const last = lines[lines.length - 1]
    if (last !== undefined && last.startsWith('💭')) {
        lines[lines.length - 1] = line
        return
    }
    pushActivityLine(lines, line)
}

const summarizeToolArgs = (args: unknown): string => {
    if (args === undefined || args === null) return ''
    try {
        return JSON.stringify(args) ?? ''
    } catch {
        return ''
    }
}

export const composeActivityPreview = (
    lines: string[],
    text: string
): string => {
    const activity = lines.join('\n')
    if (text.length === 0) return activity
    if (activity.length === 0) {
        if (text.length <= ACTIVITY_PREVIEW_BUDGET) return text
        return `…${text.slice(-(ACTIVITY_PREVIEW_BUDGET - 1))}`
    }
    const remaining = ACTIVITY_PREVIEW_BUDGET - activity.length - 2
    if (remaining <= 0) return activity
    const tail =
        text.length <= remaining ? text : `…${text.slice(-(remaining - 1))}`
    return `${activity}\n\n${tail}`
}

const MENTION_PREFIX_RE = /^\s*(?:@\S+\s+)+/u

const stripMention = (text: string): string => {
    if (typeof text !== 'string') return ''
    return text.replace(MENTION_PREFIX_RE, '').trimStart()
}

export const normalizeProviderEventId = (value: string): string | null => {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
}

const agentSendScopeKey = (target: ChannelSendTarget): string => {
    switch (target.kind) {
        case 'chat':
            return `agent-send:chat:${target.chatId}`
        case 'user':
            return `agent-send:user:${target.userId}`
        case 'reply':
            return `agent-send:reply:${target.messageId}`
    }
}

const parseStoredSendTarget = (value: unknown): ChannelSendTarget | null => {
    if (!value || typeof value !== 'object') return null
    const target = (value as { target?: unknown }).target
    if (!target || typeof target !== 'object') return null
    const t = target as {
        kind?: unknown
        chatId?: unknown
        userId?: unknown
        messageId?: unknown
    }
    if (t.kind === 'chat' && typeof t.chatId === 'string' && t.chatId)
        return { kind: 'chat', chatId: t.chatId }
    if (t.kind === 'user' && typeof t.userId === 'string' && t.userId)
        return { kind: 'user', userId: t.userId }
    if (t.kind === 'reply' && typeof t.messageId === 'string' && t.messageId)
        return { kind: 'reply', messageId: t.messageId }
    return null
}

// Legacy rows (queued before terminal was persisted) yield undefined, which
// leaves the retry indistinguishable from a plain send — the safe direction.
const parseStoredTerminal = (
    value: unknown
): 'final' | 'error' | 'cancelled' | undefined => {
    if (!value || typeof value !== 'object') return undefined
    const terminal = (value as { terminal?: unknown }).terminal
    if (
        terminal === 'final' ||
        terminal === 'error' ||
        terminal === 'cancelled'
    )
        return terminal
    return undefined
}

const parseStoredSendFiles = (value: unknown): OutboundFileRef[] | null => {
    if (!value || typeof value !== 'object') return null
    const files = (value as { files?: unknown }).files
    if (!Array.isArray(files)) return null
    const out: OutboundFileRef[] = []
    for (const item of files.slice(0, 4)) {
        if (!item || typeof item !== 'object') continue
        const ref = item as { relPath?: unknown; name?: unknown }
        if (typeof ref.relPath !== 'string' || ref.relPath.length === 0)
            continue
        if (typeof ref.name !== 'string' || ref.name.length === 0) continue
        out.push({ relPath: ref.relPath, name: ref.name })
    }
    return out.length > 0 ? out : null
}
