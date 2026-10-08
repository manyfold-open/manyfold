import type {
    EmittedChatEvent,
    EmittedErrorEvent
} from '@/modules/chat/chat-adapter'

// The durable code a turn ends with when its agent's sandbox is in
// maintenance: the provider's health check reported the machine broken, so
// the turn is refused before anything wakes it.
export const SANDBOX_MAINTENANCE_CODE = 'sandbox_maintenance'

export const SANDBOX_MAINTENANCE_MESSAGE =
    "This agent's sandbox is under maintenance: its hosting provider reported a problem with the machine, so this message was not sent. The sandbox is re-checked automatically and comes back on its own once the machine is healthy."

// Not retryable: sending again meets the same refusal until a re-check passes,
// which no client retry can bring forward.
export const sandboxMaintenanceEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: SANDBOX_MAINTENANCE_CODE,
        message: SANDBOX_MAINTENANCE_MESSAGE,
        retryable: false
    }
})

// Substituted for the adapter's stream, like the exec breaker's refusal, so
// the turn ends through the ordinary terminal path.
export async function* sandboxMaintenanceStream(): AsyncGenerator<EmittedChatEvent> {
    yield sandboxMaintenanceEvent()
}
