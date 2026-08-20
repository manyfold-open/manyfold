import { randomUUID } from 'node:crypto'
import {
    A2aClient,
    A2aError,
    fetchAgentCard,
    resolveAgentCardUrl,
    selectInterface,
    type A2aStreamEvent,
    type Message,
    type Part,
    type TextPart
} from '@manyfold/a2a'
import type { ChatMessage } from '@manyfold/shared'
import {
    type ConvergeInput,
    type ConvergeOutcome,
    type EmittedEvent,
    type ExternalProvider,
    type InvokeInput,
    type TestConnectionInput,
    type TestConnectionResult
} from '../provider'
import { withUpstreamCancel } from '../upstream-cancel'

const messageText = (msg: ChatMessage): string => {
    const parts: string[] = []
    for (const block of msg.contentBlocks) {
        if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('\n').trim()
}

const partsToText = (parts: Part[]): string =>
    parts
        .filter((part): part is TextPart => part.kind === 'text')
        .map((part) => part.text)
        .join('')

interface A2aRemoteRef {
    rpcUrl?: string
    agentCardUrl?: string
    selectedSkillId?: string
}

const resolveEndpoint = async (
    input: Pick<InvokeInput, 'config' | 'binding'>,
    signal: AbortSignal
): Promise<string> => {
    const remoteRef = input.binding.remoteRef as A2aRemoteRef
    if (remoteRef.rpcUrl) return remoteRef.rpcUrl
    const cardInput = remoteRef.agentCardUrl ?? input.config.endpointUrl
    const card = await fetchAgentCard(cardInput, {
        bearer: input.config.apiKey || undefined,
        supportedMajor: 0,
        signal
    })
    const iface = selectInterface(card, 'JSONRPC')
    return new URL(iface.url, resolveAgentCardUrl(cardInput)).toString()
}

class A2aProvider implements ExternalProvider {
    readonly kind = 'a2a' as const

    async *invoke(
        input: InvokeInput,
        signal: AbortSignal
    ): AsyncIterable<EmittedEvent> {
        // A turn that was already cancelled before invoke ran must end without
        // touching the remote at all — not even the agent-card fetch, whose
        // abort would surface as a resolve failure instead of a clean end.
        if (signal.aborted) return
        const query = messageText(input.message)
        if (!query) {
            yield {
                type: 'error',
                error: {
                    code: 'empty_message',
                    message: 'A2A provider received empty message',
                    retryable: false
                }
            }
            return
        }

        let endpointUrl: string
        try {
            endpointUrl = await resolveEndpoint(input, signal)
        } catch (err) {
            yield {
                type: 'error',
                error: {
                    code: 'a2a_resolve_failed',
                    message: (err as Error).message,
                    retryable: false
                }
            }
            return
        }

        // Resolving the endpoint is awaited, so the caller can have gone since
        // the check above; message/stream is only sent on the first read.
        if (signal.aborted) return
        const client = new A2aClient({
            endpointUrl,
            bearer: input.config.apiKey || undefined
        })
        const message: Message = {
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: query }],
            messageId: randomUUID()
        }
        if (input.session.frameworkSessionRef)
            message.contextId = input.session.frameworkSessionRef

        let sentSessionRef = false
        let sentTaskId: string | null = null
        let streamedArtifact = false
        // Aborting the stream only stops delivery; the remote A2A task keeps
        // running. The protocol has first-class cancel (tasks/cancel), so a
        // user cancel is forwarded best-effort once a task id is known — and
        // the caller's signal is deliberately kept off the stream so an abort
        // before the first task-bearing event still gets a bounded chance to
        // learn that id (#402).
        const upstream = new AbortController()
        const events = withUpstreamCancel<A2aStreamEvent>({
            source: client.sendStreamingMessage(
                {
                    message,
                    configuration: { acceptedOutputModes: ['text/plain'] }
                },
                upstream.signal
            ),
            callerSignal: signal,
            upstream,
            upstreamStarted: false,
            taskIdOf: taskIdOfEvent,
            cancelUpstream: (taskId) => {
                void client
                    .cancelTask({ id: taskId }, AbortSignal.timeout(10_000))
                    .catch((err: Error) => {
                        input.logger?.warn(
                            `a2a upstream cancel failed for task=${taskId}: ${err.message}`
                        )
                    })
            },
            skipped: (reason, windowMs) => {
                input.logger?.warn(
                    `a2a upstream_cancel=skipped_no_task_id reason=${reason} windowMs=${windowMs} session=${input.session.id}`
                )
            }
        })
        try {
            for await (const event of events) {
                const contextId = (event as { contextId?: string }).contextId
                if (contextId && !sentSessionRef) {
                    sentSessionRef = true
                    yield { type: 'session_ref', frameworkSessionRef: contextId }
                }
                // Same id upstream-cancel harvests, surfaced so a restart can
                // still ask tasks/get what happened (#670). Read from the same
                // extractor so the two never diverge.
                const taskId = taskIdOfEvent(event)
                if (taskId && taskId !== sentTaskId) {
                    sentTaskId = taskId
                    yield { type: 'upstream_ref', taskId }
                }

                if (event.kind === 'artifact-update') {
                    // Respect A2A append semantics: append=true is an incremental
                    // chunk; append=false is a full-artifact replace. Manyfold's
                    // token stream is append-only, so emit incremental chunks, and
                    // only emit a replace when nothing was streamed yet (one-shot
                    // servers) — otherwise the final snapshot duplicates the text.
                    const text = partsToText(event.artifact.parts)
                    const isAppend = event.append === true
                    if (text && (isAppend || !streamedArtifact)) {
                        yield { type: 'token', text }
                        if (isAppend) streamedArtifact = true
                    }
                } else if (event.kind === 'message') {
                    const text = partsToText(event.parts)
                    if (text) yield { type: 'token', text }
                } else if (event.kind === 'task') {
                    for (const artifact of event.artifacts ?? []) {
                        const text = partsToText(artifact.parts)
                        if (text) yield { type: 'token', text }
                    }
                    if (isFailure(event.status.state)) {
                        yield errorEvent(event.status.state, undefined)
                        return
                    }
                } else if (event.kind === 'status-update' && event.final) {
                    if (isFailure(event.status.state)) {
                        const detail = event.status.message
                            ? partsToText(event.status.message.parts)
                            : undefined
                        yield errorEvent(event.status.state, detail)
                        return
                    }
                    yield { type: 'done' }
                    return
                }
            }
            // A cancelled turn ends silently: the harvest keeps reading past
            // this point on its own lifetime, and the caller already knows the
            // terminal is cancelled_by_user.
            if (signal.aborted) return
            yield { type: 'done' }
        } catch (err) {
            if (signal.aborted) return
            if (err instanceof A2aError) {
                yield {
                    type: 'error',
                    error: {
                        code: `a2a_${err.code}`,
                        message: err.message,
                        retryable: false
                    }
                }
                return
            }
            yield {
                type: 'error',
                error: {
                    code: 'a2a_stream_error',
                    message: (err as Error).message ?? 'stream interrupted',
                    retryable: true
                }
            }
        }
    }

    // A2A is the one upstream with a first-class "what happened to this task?"
    // call, so recovery after a restart is just tasks/get on the harvested id.
    // The stream is not resubscribed: tasks/resubscribe would replay from now,
    // and the artifacts on the terminal Task already carry the whole answer.
    async converge(
        input: ConvergeInput,
        signal: AbortSignal
    ): Promise<ConvergeOutcome> {
        const taskId = input.ref.taskId
        if (!taskId)
            return {
                status: 'failed',
                error: {
                    code: 'a2a_converge_no_ref',
                    message:
                        'the interrupted A2A turn has no upstream task reference',
                    retryable: true
                }
            }
        const endpointUrl = await resolveEndpoint(input, signal)
        const client = new A2aClient({
            endpointUrl,
            bearer: input.config.apiKey || undefined
        })
        const task = await client.getTask({ id: taskId }, signal)
        const state = task.status.state
        // submitted/working are the only states that mean "come back later".
        // `unknown` joins them rather than terminalizing: the spec uses it for
        // a server that cannot answer yet, and the caller's budget bounds it.
        if (state === 'submitted' || state === 'working' || state === 'unknown')
            return { status: 'running' }
        if (state === 'canceled') return { status: 'cancelled' }
        if (isFailure(state))
            return {
                status: 'failed',
                error: {
                    code: `a2a_${state}`,
                    message: task.status.message
                        ? partsToText(task.status.message.parts)
                        : `remote A2A task ${state}`,
                    retryable: false
                }
            }
        // completed / input-required / auth-required: the task stopped
        // producing, so deliver what it produced. The live path treats the same
        // non-failure final states as `done`.
        const artifacts = (task.artifacts ?? [])
            .map((artifact) => partsToText(artifact.parts))
            .filter((text) => text.length > 0)
        const text =
            artifacts.length > 0
                ? artifacts.join('\n')
                : task.status.message
                  ? partsToText(task.status.message.parts)
                  : ''
        return { status: 'completed', text }
    }

    async testConnection(
        input: TestConnectionInput
    ): Promise<TestConnectionResult> {
        try {
            const card = await fetchAgentCard(input.config.endpointUrl, {
                bearer: input.config.apiKey || undefined,
                supportedMajor: 0
            })
            return {
                ok: true,
                message: `${card.name} (A2A ${card.protocolVersion})`
            }
        } catch (err) {
            return {
                ok: false,
                message: (err as Error).message ?? 'connection failed'
            }
        }
    }
}

const taskIdOfEvent = (event: A2aStreamEvent): string | null =>
    event.kind === 'task'
        ? event.id
        : event.kind === 'status-update' || event.kind === 'artifact-update'
          ? event.taskId
          : null

const isFailure = (state: string): boolean =>
    state === 'failed' || state === 'rejected'

const errorEvent = (state: string, detail?: string): EmittedEvent => ({
    type: 'error',
    error: {
        code: `a2a_${state}`,
        message: detail ?? `remote A2A task ${state}`,
        retryable: false
    }
})

export const a2aProvider = new A2aProvider()
