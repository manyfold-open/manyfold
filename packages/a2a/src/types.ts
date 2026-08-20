// A2A protocol types — hand-defined v0.3 subset (matches @a2a-js/sdk@0.3.13).
// Kept self-contained so packages/a2a has no upward dependency on providers.
// Source of truth: A2A spec v0.3 (https://a2a-protocol.org/v0.3.0/specification/).

export type A2aTransport = 'JSONRPC' | 'HTTP+JSON' | 'GRPC'

export interface AgentInterface {
    url: string
    transport: A2aTransport
}

export interface AgentProvider {
    organization: string
    url: string
}

export interface AgentSkill {
    id: string
    name: string
    description?: string
    tags?: string[]
    examples?: string[]
    inputModes?: string[]
    outputModes?: string[]
}

export interface AgentCapabilities {
    streaming?: boolean
    pushNotifications?: boolean
    stateTransitionHistory?: boolean
}

export interface SecurityScheme {
    type: string
    scheme?: string
    description?: string
    name?: string
    in?: string
}

export interface AgentCard {
    protocolVersion: string
    name: string
    description?: string
    url: string
    preferredTransport: A2aTransport
    additionalInterfaces?: AgentInterface[]
    provider?: AgentProvider
    version?: string
    documentationUrl?: string
    capabilities?: AgentCapabilities
    defaultInputModes?: string[]
    defaultOutputModes?: string[]
    skills?: AgentSkill[]
    securitySchemes?: Record<string, SecurityScheme>
    security?: Array<Record<string, string[]>>
    supportsAuthenticatedExtendedCard?: boolean
}

export interface TextPart {
    kind: 'text'
    text: string
    metadata?: Record<string, unknown>
}

export interface FileWithBytes {
    name?: string
    mimeType?: string
    bytes: string
}

export interface FileWithUri {
    name?: string
    mimeType?: string
    uri: string
}

export interface FilePart {
    kind: 'file'
    file: FileWithBytes | FileWithUri
    metadata?: Record<string, unknown>
}

export interface DataPart {
    kind: 'data'
    data: Record<string, unknown>
    metadata?: Record<string, unknown>
}

export type Part = TextPart | FilePart | DataPart

export type Role = 'user' | 'agent'

export interface Message {
    kind: 'message'
    role: Role
    parts: Part[]
    messageId: string
    taskId?: string
    contextId?: string
    referenceTaskIds?: string[]
    metadata?: Record<string, unknown>
}

export type TaskState =
    | 'submitted'
    | 'working'
    | 'input-required'
    | 'completed'
    | 'canceled'
    | 'failed'
    | 'rejected'
    | 'auth-required'
    | 'unknown'

export interface TaskStatus {
    state: TaskState
    message?: Message
    timestamp?: string
}

export interface Artifact {
    artifactId: string
    name?: string
    description?: string
    parts: Part[]
    metadata?: Record<string, unknown>
}

export interface Task {
    kind: 'task'
    id: string
    contextId: string
    status: TaskStatus
    artifacts?: Artifact[]
    history?: Message[]
    metadata?: Record<string, unknown>
}

export interface TaskStatusUpdateEvent {
    kind: 'status-update'
    taskId: string
    contextId: string
    status: TaskStatus
    final: boolean
    metadata?: Record<string, unknown>
}

export interface TaskArtifactUpdateEvent {
    kind: 'artifact-update'
    taskId: string
    contextId: string
    artifact: Artifact
    append?: boolean
    lastChunk?: boolean
    metadata?: Record<string, unknown>
}

export type A2aStreamEvent =
    | Message
    | Task
    | TaskStatusUpdateEvent
    | TaskArtifactUpdateEvent

export interface MessageSendConfiguration {
    acceptedOutputModes?: string[]
    blocking?: boolean
    historyLength?: number
}

export interface MessageSendParams {
    message: Message
    configuration?: MessageSendConfiguration
    metadata?: Record<string, unknown>
}

export interface TaskQueryParams {
    id: string
    historyLength?: number
    metadata?: Record<string, unknown>
}

export interface TaskIdParams {
    id: string
    metadata?: Record<string, unknown>
}

export interface JsonRpcRequest<P = unknown> {
    jsonrpc: '2.0'
    id: string | number
    method: string
    params: P
}

export interface JsonRpcErrorBody {
    code: number
    message: string
    data?: unknown
}

export interface JsonRpcResponse<R = unknown> {
    jsonrpc: '2.0'
    id: string | number | null
    result?: R
    error?: JsonRpcErrorBody
}

export const A2aMethod = {
    messageSend: 'message/send',
    messageStream: 'message/stream',
    tasksGet: 'tasks/get',
    tasksCancel: 'tasks/cancel',
    tasksResubscribe: 'tasks/resubscribe'
} as const
