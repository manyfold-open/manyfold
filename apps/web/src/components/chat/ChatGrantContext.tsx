import { createContext, useContext } from 'react'

export interface ChatGrantActions {
    // Sends a visible user message into the active chat session and starts the
    // agent's next turn. Used to auto-continue after the owner approves or
    // denies an in-chat permission request, so they never have to type "done".
    continueAfterGrant: (text: string) => void
}

const ChatGrantContext = createContext<ChatGrantActions | null>(null)

export const ChatGrantProvider = ChatGrantContext.Provider

export const useChatGrantActions = (): ChatGrantActions | null =>
    useContext(ChatGrantContext)
