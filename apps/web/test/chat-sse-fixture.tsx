import { createRoot } from 'react-dom/client'
import { createClient } from '@manyfold/sdk'
import { I18nProvider, i18nReady } from '@/lib/i18n'
import { ChatStreamRecoveryNotice } from '@/components/chat/ChatStreamRecoveryNotice'
import {
    chatStreamStore,
    useStreamSnapshot,
    type ChatStreamTelemetryEvent
} from '@/lib/chatStreamStore'
import '@/styles.css'

const events: ChatStreamTelemetryEvent[] = []
let fallbackCalls = 0
let resolvedPages = 0
const key = chatStreamStore.keyOf('fixture-agent', 'fixture-session')
const client = createClient({ baseUrl: location.origin })
const params = {
    agentId: 'fixture-agent',
    sessionId: 'fixture-session',
    baseUrl: location.origin,
    getToken: async () => '',
    initialLastEventId: '1',
    onFallback: async (signal?: AbortSignal) => {
        fallbackCalls++
        const page = await client.chat.listMessagePage(
            'fixture-agent',
            'fixture-session',
            { signal }
        )
        if (!signal?.aborted) {
            chatStreamStore.acknowledgeMessagePage(key, page)
            resolvedPages++
        }
    }
}
chatStreamStore.setTelemetry((event) => events.push(event))
const fixture = {
    start(messageId?: string) {
        if (messageId)
            chatStreamStore.beginAssistantTurn(key, params, messageId)
        else chatStreamStore.getOrStart(params)
    },
    read() {
        return {
            snapshot: chatStreamStore.getSnapshot(key),
            events,
            fallbackCalls,
            resolvedPages
        }
    },
    clear() {
        chatStreamStore.clear()
    }
}
Object.assign(window, { __chatSseFixture: fixture })

const Fixture = () => {
    const snapshot = useStreamSnapshot(key)
    return (
        <main className='bg-main text-fg min-h-screen px-5 py-6'>
            <div className='mx-auto flex max-w-3xl flex-col gap-5'>
                <h1 className='text-h2'>Workspace review</h1>
                {snapshot.reconnectRequired && (
                    <ChatStreamRecoveryNotice
                        onReconnect={() => chatStreamStore.reconnect(key)}
                        onReload={() => location.reload()}
                    />
                )}
                <p className='text-ui'>
                    The current review is still in progress.
                </p>
            </div>
        </main>
    )
}
await i18nReady
createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <Fixture />
    </I18nProvider>
)
