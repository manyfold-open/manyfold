import { chatCapabilitiesByFramework } from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatError,
    ChatMessage,
    ChatUploadBlock,
    ExternalAgentProviderKind
} from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import {
    getExternalProvider,
    type ConvergeInput,
    type ConvergeOutcome,
    type ExternalProvider,
    type ExternalProviderKind,
    type InvokeFile
} from '@manyfold/external-providers'
import { DRIZZLE } from '@/db/tokens'
import type {
    ApiChatAdapter,
    ApiChatAdapterContext,
    ApiChatConvergeContext,
    EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { MAX_TIMER_DELAY_MS } from '@/modules/chat/turn-budgets'
import { UserExternalAgentProvidersService } from '@/modules/user-external-agent-providers/user-external-agent-providers.service'
import { ChatUploadStorageService } from '@/modules/chat/uploads/chat-upload-storage.service'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'

interface ExternalBinding {
    providerId: string
    framework: ExternalAgentProviderKind
    remoteRef: Record<string, unknown>
}

// Gap between upstream state polls during turn convergence. Short because the
// common case is a turn that finished during the deploy and is one call away;
// the total is bounded by the turn budgets, never by a count here.
export const DEFAULT_CONVERGE_POLL_INTERVAL_MS = 3_000
const CONVERGE_MAX_FAILED_POLLS = 5

// Read per call, not at module load, so an operator (and a test) can change it
// on a running process — same reasoning as the turn budgets.
//
// Accepted range: any finite value in (0, MAX_TIMER_DELAY_MS]. Anything above
// is taken as "as slow as a single timer can be" and clamped DOWN; anything
// unparseable or non-positive falls back to the default. Node stores a timer
// delay in a signed 32-bit int and rewrites an overflowing one to 1ms (#668),
// and here that inverts the operator's intent at the worst possible place:
// every `running` outcome resets the failure streak, so "poll Dify less often"
// would have become a ~1ms hammer on the upstream, bounded only by the turn
// watchdog. The clamp is the same policy the budgets apply to the same overflow.
export const resolveConvergePollIntervalMs = (): number => {
    const raw = Number(process.env.MF_EXTERNAL_CONVERGE_POLL_MS)
    return Number.isFinite(raw) && raw > 0
        ? Math.min(raw, MAX_TIMER_DELAY_MS)
        : DEFAULT_CONVERGE_POLL_INTERVAL_MS
}

const sleepUnlessAborted = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        if (typeof timer.unref === 'function') timer.unref()
        const onAbort = (): void => {
            clearTimeout(timer)
            resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })

const collectToBuffer = async (
    stream: AsyncIterable<Uint8Array>
): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
}

const isDifySessionRefFailure = (error: ChatError): boolean => {
    const text = `${error.code} ${error.message}`.toLowerCase()
    if (error.code === 'dify_session_not_found') return true
    if (
        text.includes('conversationnotexistserror') ||
        text.includes('conversation_not_exists') ||
        text.includes('conversation not exists') ||
        text.includes('conversation not found') ||
        (text.includes('conversation') && text.includes('not exist'))
    )
        return true
    return (
        error.code === 'dify_stream_error' &&
        (text.includes('terminated') || text.includes('other side closed'))
    )
}

abstract class ExternalApiChatAdapterBase implements ApiChatAdapter {
    abstract readonly framework: AgentFramework
    private readonly log = new Logger(ExternalApiChatAdapterBase.name)

    constructor(
        @Inject(DRIZZLE) protected readonly db: Database,
        protected readonly providers: UserExternalAgentProvidersService,
        protected readonly chatRepo: ChatRepository,
        @Optional()
        protected readonly uploads?: ChatUploadStorageService
    ) {}

    getCapabilities(): ChatCapabilities {
        return chatCapabilitiesByFramework[this.framework]
    }

    private async persistUpstreamRef(
        ctx: ApiChatAdapterContext,
        ref: { taskId: string | null; upstreamMessageId: string | null },
        signal: AbortSignal
    ): Promise<boolean> {
        if (!ctx.onUpstreamRef || signal.aborted) return !signal.aborted
        let write: Promise<void>
        try {
            write = Promise.resolve(ctx.onUpstreamRef(ref))
        } catch (err) {
            if (err instanceof TurnFenceLostError) throw err
            this.log.error(
                `upstream ref sink failed messageId=${ctx.messageId}: ${(err as Error).message}`
            )
            return !signal.aborted
        }
        const settled = write.then(
            () => true,
            (err) => {
                if (err instanceof TurnFenceLostError) throw err
                this.log.error(
                    `upstream ref sink failed messageId=${ctx.messageId}: ${(err as Error).message}`
                )
                return true
            }
        )
        if (signal.aborted) {
            void settled
            return false
        }
        let onAbort!: () => void
        const aborted = new Promise<false>((resolve) => {
            onAbort = () => resolve(false)
            signal.addEventListener('abort', onAbort, { once: true })
        })
        const result = await Promise.race([settled, aborted])
        signal.removeEventListener('abort', onAbort)
        return result
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        // Bridged BEFORE the agent row and provider lookups below, and
        // mirrored immediately, because an AbortSignal never replays to a
        // listener registered afterwards. A cancel landing inside either await
        // used to leave this controller live, so the provider — which does
        // nothing when its OWN signal is already aborted (#652) — was told the
        // turn was still wanted: Dify read the upload and POSTed
        // /v1/chat-messages, A2A fetched the card and opened message/stream,
        // and the local terminal converged to cancelled_by_user over an
        // upstream task that kept generating and billing (#402).
        const controller = new AbortController()
        const onAbort = (): void => controller.abort()
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (ctx.abortSignal?.aborted) controller.abort()
        try {
            const [agent] = await this.db
                .select()
                .from(agents)
                .where(eq(agents.id, ctx.agentId))
                .limit(1)
            if (!agent) throw new NotFoundException(`agent ${ctx.agentId}`)
            const binding = (
                agent.extras as { externalBinding?: ExternalBinding }
            )?.externalBinding
            if (!binding) {
                yield {
                    type: 'error',
                    error: {
                        code: 'missing_binding',
                        message: 'agent has no externalBinding in extras',
                        retryable: false
                    }
                }
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            let provider: Awaited<
                ReturnType<UserExternalAgentProvidersService['resolveForUser']>
            >
            try {
                provider = await this.providers.resolveForUser({
                    userId: agent.userId,
                    id: binding.providerId
                })
            } catch (err) {
                yield {
                    type: 'error',
                    error: {
                        code: 'external_provider_unavailable',
                        message: (err as Error).message,
                        retryable: false
                    }
                }
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            if (provider.provider !== binding.framework) {
                yield {
                    type: 'error',
                    error: {
                        code: 'provider_kind_mismatch',
                        message: `external provider ${binding.providerId} is ${provider.provider}, not ${binding.framework}`,
                        retryable: false
                    }
                }
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            // Both awaits above can have absorbed the cancel. Nothing that
            // creates upstream work — not the lazy upload closures, not the
            // invoke below — may run past this point for a dead turn; the
            // terminal is still a local `done`, which chat.service normalizes
            // to cancelled_by_user.
            if (controller.signal.aborted) {
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            const impl = getExternalProvider(
                binding.framework as ExternalProviderKind
            )
            const config = {
                endpointUrl: provider.endpointUrl,
                apiKey: provider.apiKey,
                metadata: provider.metadata
            }
            const uploadBlocks = userMessage.contentBlocks.filter(
                (b): b is ChatUploadBlock => b.type === 'upload'
            )
            const files: InvokeFile[] | undefined =
                uploadBlocks.length > 0
                    ? uploadBlocks.map((block) => ({
                          name: block.name,
                          contentType: block.contentType,
                          size: block.size,
                          read: async (): Promise<Buffer> => {
                              if (!this.uploads)
                                  throw new Error(
                                      'chat-upload storage is not configured'
                                  )
                              return collectToBuffer(
                                  await this.uploads.read(
                                      block.uploadId,
                                      agent.userId,
                                      ctx.agentId
                                  )
                              )
                          }
                      }))
                    : undefined
            let frameworkSessionRef = ctx.frameworkSessionRef
            let retriedWithoutSessionRef = false
            while (true) {
                const stream = impl.invoke(
                    {
                        config,
                        binding: { remoteRef: binding.remoteRef },
                        session: {
                            id: ctx.sessionId,
                            frameworkSessionRef
                        },
                        message: userMessage,
                        history: ctx.history,
                        model: ctx.model,
                        modelConfig: ctx.modelConfig,
                        files,
                        logger: {
                            warn: (message: string) => this.log.warn(message)
                        }
                    },
                    controller.signal
                )
                let sawDone = false
                let sawProviderProgress = false
                let retryWithoutSessionRef = false
                try {
                    for await (const event of stream) {
                        if (event.type === 'upstream_ref') {
                            // Never forwarded: it is bookkeeping for the
                            // adoption sweep, not turn content. Deliberately
                            // does NOT count as provider progress — the
                            // stale-conversation retry below must still fire
                            // for an error chunk, and Dify stamps task_id on
                            // that chunk too.
                            //
                            // Provider progress waits for durability. Abort is
                            // the only escape: it stops this iterator without
                            // consuming another provider event while the DB
                            // promise remains observed in the background.
                            if (
                                !(await this.persistUpstreamRef(
                                    ctx,
                                    {
                                        taskId: event.taskId ?? null,
                                        upstreamMessageId:
                                            event.upstreamMessageId ?? null
                                    },
                                    controller.signal
                                ))
                            )
                                return
                            continue
                        }
                        if (event.type === 'session_ref') {
                            if (event.frameworkSessionRef.length > 0) {
                                sawProviderProgress = true
                                await this.chatRepo
                                    .updateFrameworkSessionRef(
                                        ctx.sessionId,
                                        event.frameworkSessionRef,
                                        ctx.turnFence
                                    )
                                    .catch((err) => {
                                        if (err instanceof TurnFenceLostError)
                                            throw err
                                        this.log.warn(
                                            `updateFrameworkSessionRef failed: ${(err as Error).message}`
                                        )
                                    })
                            }
                            continue
                        }
                        if (
                            event.type === 'error' &&
                            this.shouldRetryWithoutSessionRef({
                                framework: binding.framework,
                                error: event.error,
                                retriedWithoutSessionRef,
                                frameworkSessionRef,
                                sawProviderProgress
                            })
                        ) {
                            retryWithoutSessionRef = true
                            break
                        }
                        if (event.type === 'done') {
                            sawDone = true
                            await this.deleteUploads(
                                uploadBlocks,
                                agent.userId,
                                ctx.agentId
                            )
                            yield {
                                type: 'done',
                                finalMessageId: ctx.messageId
                            }
                            return
                        }
                        sawProviderProgress = true
                        yield event
                    }
                } catch (err) {
                    if (err instanceof TurnFenceLostError) throw err
                    this.log.error(
                        `external provider ${binding.framework} failed: ${(err as Error).message}`
                    )
                    yield {
                        type: 'error',
                        error: {
                            code: 'external_provider_failed',
                            message: (err as Error).message ?? 'internal error',
                            retryable: false
                        }
                    }
                }
                if (retryWithoutSessionRef) {
                    await this.chatRepo
                        .updateFrameworkSessionRef(
                            ctx.sessionId,
                            null,
                            ctx.turnFence
                        )
                        .catch((err) => {
                            if (err instanceof TurnFenceLostError) throw err
                            this.log.warn(
                                `clearFrameworkSessionRef failed: ${(err as Error).message}`
                            )
                        })
                    this.log.warn(
                        `retrying ${binding.framework} session=${ctx.sessionId} without stale framework session ref`
                    )
                    frameworkSessionRef = null
                    retriedWithoutSessionRef = true
                    continue
                }
                if (!sawDone) {
                    yield { type: 'done', finalMessageId: ctx.messageId }
                }
                return
            }
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }
    }

    // Finish a turn whose relay died mid-flight (deploy/crash) by asking the
    // upstream what became of it. Returns null — "do not pretend" — whenever
    // the honest answer is unknowable: langflow exposes no task id and no query
    // API at all, and dify/a2a turns killed before their first ref-bearing
    // chunk have nothing to ask about. Those keep the pre-#670 retryable
    // server_restart terminal.
    convergeTurn(
        ctx: ApiChatConvergeContext
    ): AsyncIterable<EmittedChatEvent> | null {
        if (this.framework === 'dify') {
            // The messages API is queried by conversation; only the message id
            // says WHICH answer in it is this turn's.
            if (!ctx.frameworkSessionRef || !ctx.upstreamMessageId) return null
        } else if (this.framework === 'a2a') {
            if (!ctx.upstreamTaskId) return null
        } else return null
        return this.convergeStream(ctx)
    }

    // Poll until the upstream reports a terminal, then deliver the whole answer
    // as one `replace` under the ORIGINAL assistant messageId (the same event
    // Dify output moderation already uses, so web/channel clients rebuild the
    // message from it without a new turn). Nothing is yielded while polling —
    // deliberately: an event would rearm the turn idle budget, and that budget
    // is the only thing bounding an upstream that never finishes (#668).
    private async *convergeStream(
        ctx: ApiChatConvergeContext
    ): AsyncIterable<EmittedChatEvent> {
        let resolved: {
            impl: ExternalProvider
            input: ConvergeInput
        }
        try {
            resolved = await this.resolveConvergeTarget(ctx)
        } catch (err) {
            yield {
                type: 'error',
                error: {
                    code: 'external_converge_unavailable',
                    message: (err as Error).message,
                    retryable: true
                }
            }
            return
        }
        const converge = resolved.impl.converge
        if (!converge) return
        let failedStreak = 0
        for (;;) {
            if (ctx.abortSignal.aborted) return
            let outcome: ConvergeOutcome
            try {
                outcome = await converge.call(
                    resolved.impl,
                    resolved.input,
                    ctx.abortSignal
                )
                failedStreak = 0
            } catch (err) {
                if (ctx.abortSignal.aborted) return
                failedStreak += 1
                this.log.warn(
                    `external converge poll failed (${failedStreak}/${CONVERGE_MAX_FAILED_POLLS}) messageId=${ctx.messageId}: ${(err as Error).message}`
                )
                // A streak means the upstream is unreachable, not slow. Give up
                // with a retryable terminal instead of waiting out the whole
                // turn budget on a call that will keep failing.
                if (failedStreak >= CONVERGE_MAX_FAILED_POLLS) {
                    yield {
                        type: 'error',
                        error: {
                            code: 'external_converge_failed',
                            message: `could not reach the ${this.framework} upstream to recover this turn: ${(err as Error).message}`,
                            retryable: true
                        }
                    }
                    return
                }
                outcome = { status: 'running' }
            }
            if (outcome.status === 'completed') {
                yield {
                    type: 'replace',
                    text: outcome.text,
                    reason: 'upstream_converged'
                }
                yield { type: 'done', finalMessageId: ctx.messageId }
                return
            }
            if (outcome.status === 'failed') {
                yield { type: 'error', error: outcome.error }
                return
            }
            if (outcome.status === 'cancelled') {
                // Not `cancelled_by_user`: this user's cancel goes through the
                // local abort path. Something upstream stopped the task.
                yield {
                    type: 'error',
                    error: {
                        code: `${this.framework}_upstream_cancelled`,
                        message:
                            'the upstream task was cancelled while this turn was interrupted',
                        retryable: true
                    }
                }
                return
            }
            await sleepUnlessAborted(
                resolveConvergePollIntervalMs(),
                ctx.abortSignal
            )
        }
    }

    private async resolveConvergeTarget(ctx: ApiChatConvergeContext): Promise<{
        impl: ExternalProvider
        input: ConvergeInput
    }> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, ctx.agentId))
            .limit(1)
        if (!agent) throw new NotFoundException(`agent ${ctx.agentId}`)
        const binding = (agent.extras as { externalBinding?: ExternalBinding })
            ?.externalBinding
        if (!binding) throw new Error('agent has no externalBinding in extras')
        const provider = await this.providers.resolveForUser({
            userId: agent.userId,
            id: binding.providerId
        })
        if (provider.provider !== binding.framework)
            throw new Error(
                `external provider ${binding.providerId} is ${provider.provider}, not ${binding.framework}`
            )
        return {
            impl: getExternalProvider(
                binding.framework as ExternalProviderKind
            ),
            input: {
                config: {
                    endpointUrl: provider.endpointUrl,
                    apiKey: provider.apiKey,
                    metadata: provider.metadata
                },
                binding: { remoteRef: binding.remoteRef },
                session: {
                    id: ctx.sessionId,
                    frameworkSessionRef: ctx.frameworkSessionRef
                },
                ref: {
                    taskId: ctx.upstreamTaskId,
                    upstreamMessageId: ctx.upstreamMessageId
                },
                logger: { warn: (message: string) => this.log.warn(message) }
            }
        }
    }

    private shouldRetryWithoutSessionRef(input: {
        framework: ExternalAgentProviderKind
        error: ChatError
        retriedWithoutSessionRef: boolean
        frameworkSessionRef: string | null
        sawProviderProgress: boolean
    }): boolean {
        return (
            input.framework === 'dify' &&
            input.frameworkSessionRef !== null &&
            !input.retriedWithoutSessionRef &&
            !input.sawProviderProgress &&
            isDifySessionRefFailure(input.error)
        )
    }

    private async deleteUploads(
        blocks: ChatUploadBlock[],
        userId: string,
        agentId: string
    ): Promise<void> {
        if (!this.uploads || blocks.length === 0) return
        for (const block of blocks) {
            await this.uploads
                .delete(block.uploadId, userId, agentId)
                .catch((err) =>
                    this.log.warn(
                        `chat-upload cleanup failed: ${(err as Error).message}`
                    )
                )
        }
    }
}

@Injectable()
export class DifyChatAdapter extends ExternalApiChatAdapterBase {
    readonly framework: AgentFramework = 'dify'
}

@Injectable()
export class LangflowChatAdapter extends ExternalApiChatAdapterBase {
    readonly framework: AgentFramework = 'langflow'
}

@Injectable()
export class A2aChatAdapter extends ExternalApiChatAdapterBase {
    readonly framework: AgentFramework = 'a2a'
}
