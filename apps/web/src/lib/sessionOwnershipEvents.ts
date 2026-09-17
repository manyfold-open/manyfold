import type { ChatSessionsChangedEvent } from '@manyfold/shared'

// The sessions-changed stream reaches the app shell, which refetches the
// list; the chat page also wants the event itself for the one-line notice
// about an ownership transition (a terminal released the session, its
// transcript was imported or abandoned). In-tab only: each tab has its own
// stream.
type Listener = (event: ChatSessionsChangedEvent) => void

const listeners = new Set<Listener>()

export const publishSessionsChanged = (
    event: ChatSessionsChangedEvent
): void => {
    for (const listener of listeners) listener(event)
}

export const subscribeSessionsChanged = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}
