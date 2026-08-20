import type { ChatContentBlock, ChatRole } from './chat'

// Public DTOs for the OpenAI-compatible read-only conversation API
// (GET /api/v1/conversations[/{session_id}/messages]). Field names are
// brand-neutral on purpose (no nca_ prefix); the identifier is session_id
// (the same value x-session-id returns), the public noun is "conversation".

export interface ConversationListEnvelope<T> {
    object: 'list'
    data: T[]
    first_id: string | null
    last_id: string | null
    has_more: boolean
}

export interface ConversationObject {
    object: 'conversation'
    id: string
    model: string
    title: string | null
    created_at: number
    updated_at: number
}

export interface ConversationMessageTextPart {
    type: 'text'
    text: string
}

export interface ConversationMessageObject {
    id: string
    object: 'message'
    role: ChatRole
    content: ConversationMessageTextPart[]
    // Full-fidelity rich blocks (tool_call / tool_result / thinking / ...),
    // mapped from the shared ChatContentBlock union so a new block type is a
    // compile-time touchpoint. Absolute filesystem paths are sanitized before
    // they reach this public shape.
    content_blocks: ChatContentBlock[]
    model: string | null
    created_at: number
}