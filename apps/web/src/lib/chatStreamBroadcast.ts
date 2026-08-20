export type ChatStreamBroadcastMessage =
    | {
          type: 'turn-begin'
          agentId: string
          sessionId: string
          assistantMessageId: string
      }
    | {
          type: 'cancel'
          agentId: string
          sessionId: string
          assistantMessageId: string
      }

const CHANNEL_NAME = 'nca.chatStream'

let channel: BroadcastChannel | null = null
let channelTried = false
const listeners = new Set<(msg: ChatStreamBroadcastMessage) => void>()

const ensureChannel = (): BroadcastChannel | null => {
    if (channelTried) return channel
    channelTried = true
    if (typeof BroadcastChannel === 'undefined') return null
    try {
        channel = new BroadcastChannel(CHANNEL_NAME)
        channel.onmessage = (event: MessageEvent): void => {
            const data = event.data as ChatStreamBroadcastMessage | null
            if (!data || typeof data !== 'object') return
            for (const listener of listeners) listener(data)
        }
    } catch {
        channel = null
    }
    return channel
}

export const publishStreamEvent = (msg: ChatStreamBroadcastMessage): void => {
    const ch = ensureChannel()
    if (!ch) return
    try {
        ch.postMessage(msg)
    } catch {
        /* ignore — closed channel / serialization */
    }
}

export const subscribeStreamEvents = (
    listener: (msg: ChatStreamBroadcastMessage) => void
): (() => void) => {
    ensureChannel()
    listeners.add(listener)
    return (): void => {
        listeners.delete(listener)
    }
}
