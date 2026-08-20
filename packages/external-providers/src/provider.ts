import type {
    AgentModelConfig,
    ChatError,
    ChatMessage,
    ChatUsage
} from '@manyfold/shared'

export type ExternalProviderKind = 'dify' | 'langflow' | 'a2a'

export interface ProviderConfig {
    endpointUrl: string
    apiKey: string
    metadata?: Record<string, unknown>
}

export interface InvokeFile {
    name: string
    contentType: string
    size: number
    read(): Promise<Buffer>
}

export interface InvokeInput {
    config: ProviderConfig
    binding: { remoteRef: Record<string, unknown> }
    session: { id: string; frameworkSessionRef: string | null }
    message: ChatMessage
    history: ChatMessage[]
    model: string | null
    modelConfig: AgentModelConfig | null
    files?: InvokeFile[]
    // Best-effort observability for fire-and-forget work (upstream stop on
    // abort) whose outcome can no longer be yielded as a stream event.
    logger?: ProviderLogger
}

export interface ProviderLogger {
    warn(message: string): void
}

export type EmittedEvent =
    | { type: 'token'; text: string }
    | {
          type: 'tool_call'
          toolCallId: string
          toolName: string
          args: unknown
          elapsedMs?: number
      }
    | {
          type: 'tool_result'
          toolCallId: string
          result: unknown
          elapsedMs?: number
      }
    | { type: 'thinking'; text: string }
    | { type: 'replace'; text: string; reason: string }
    | { type: 'usage'; usage: ChatUsage }
    | { type: 'session_ref'; frameworkSessionRef: string }
    // The handles that name this turn's work INSIDE the upstream, emitted the
    // moment the stream first reveals them. Until #670 they only ever lived in
    // the upstream-cancel closure, so a relay that died mid-turn took the only
    // way of asking "did it finish?" with it. Fields are optional and arrive
    // independently (Dify learns task_id and message_id on the same chunk, but
    // a workflow app can emit task_id first), so the consumer merges rather
    // than overwrites.
    | {
          type: 'upstream_ref'
          taskId?: string
          upstreamMessageId?: string
      }
    | { type: 'error'; error: ChatError }
    | { type: 'done' }

export interface TestConnectionInput {
    config: ProviderConfig
}

export interface TestConnectionResult {
    ok: boolean
    message: string
    models?: string[]
}

// One upstream poll for a turn whose local relay is gone. Deliberately a single
// question-and-answer rather than a stream: the upstream offers no mid-turn
// re-attach, so the only honest recovery is "what is the state of this task
// now?", asked repeatedly by the caller.
export interface ConvergeInput {
    config: ProviderConfig
    binding: { remoteRef: Record<string, unknown> }
    session: { id: string; frameworkSessionRef: string | null }
    ref: { taskId: string | null; upstreamMessageId: string | null }
    logger?: ProviderLogger
}

export type ConvergeOutcome =
    // Upstream is still working; ask again later.
    | { status: 'running' }
    // Upstream finished. `text` is the WHOLE answer, not a delta — the caller
    // replaces everything it had delivered before the relay died.
    | { status: 'completed'; text: string }
    | { status: 'failed'; error: ChatError }
    | { status: 'cancelled' }

export interface ExternalProvider {
    readonly kind: ExternalProviderKind
    invoke(input: InvokeInput, signal: AbortSignal): AsyncIterable<EmittedEvent>
    testConnection(input: TestConnectionInput): Promise<TestConnectionResult>
    // Absent when the upstream exposes no way to ask after the fact (langflow
    // has neither a task id nor a query API), which is what makes the caller's
    // "do not pretend to recover" branch a capability check instead of a guess.
    converge?(
        input: ConvergeInput,
        signal: AbortSignal
    ): Promise<ConvergeOutcome>
}
