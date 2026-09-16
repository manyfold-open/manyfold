import type { ChatMessage } from '@manyfold/shared'
import { CodexAdapter } from '../src/modules/chat/adapters/codex.adapter'
import { GeminiCliAdapter } from '../src/modules/chat/adapters/gemini-cli.adapter'
import type {
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'

export const runAdapterWire = async (
    framework: 'codex' | 'gemini-cli',
    stdout: string,
    options: {
        resume?: boolean
        stderr?: string
        exitCode?: number
        sessionRef?: string
    } = {}
) => {
    const calls: { kind: string; fromSeq?: number }[] = []
    const refs: (string | null)[] = []
    const handle = () => ({
        stdout: (async function* () {
            // Split inside a JSON line, as real exec chunks can be split.
            yield stdout.slice(0, 31)
            yield stdout.slice(31)
        })(),
        stderr: (async function* () {
            yield options.stderr ?? ''
        })(),
        result: Promise.resolve({
            exitCode: options.exitCode ?? 0,
            stdout: '',
            stderr: options.stderr ?? ''
        }),
        abort: () => {},
        lastDeliveredSeq: () => 13
    })
    const driver = {
        stream: () => {
            calls.push({ kind: 'send' })
            return handle()
        },
        resumeStream: ({ fromSeq }: { fromSeq: number }) => {
            calls.push({ kind: 'resume', fromSeq })
            return handle()
        }
    }
    const drivers = {
        forAgent: async () => ({
            driver,
            creds: null,
            runtime: 'sprites',
            agent: {
                id: 'agt_fixture',
                daemonId: null,
                workspacePath: '/fixture'
            }
        }),
        daemonDriverFor: () => driver,
        recoveryFsForAgent: async () => ({
            runtime: 'sprites',
            fs: {
                exec: async () => '1\n',
                locate: async () => null,
                readFile: async () => null,
                listFiles: async () => []
            }
        })
    }
    const repo = {
        updateFrameworkSessionRef: async (_id: string, ref: string | null) => {
            refs.push(ref)
        },
        setRuntimeSyncCursor: async () => {},
        clearFrameworkSessionRefIfMatches: async () => true
    }
    const settings = {
        getCachedChatExecTimeoutMs: async () => ({
            timeoutMs: 1000,
            keepAliveMs: 1000,
            livenessTimeoutMs: 1000
        })
    }
    const Adapter = framework === 'codex' ? CodexAdapter : GeminiCliAdapter
    const adapter = new Adapter(
        drivers as never,
        repo as never,
        {
            priceFor: () => null,
            computeCost: () => ({ costUsd: null, costSource: null })
        } as never,
        settings as never
    )
    const context = {
        userId: 'user_fixture',
        agentId: 'agt_fixture',
        runtimeId: 'art_fixture',
        sessionId: 'cts_fixture',
        messageId: 'msg_fixture',
        runtimeKind: 'sprites',
        model: null,
        modelOverride: null,
        modelConfig: null,
        history: [],
        frameworkSessionRef: options.resume
            ? (options.sessionRef ?? 'e3b879e6-303b-4bc0-b916-ef62f28e943d')
            : null,
        daemonId: 'daemon_fixture',
        daemonExecRef: 'msg_fixture',
        fromSeq: 12
    } as unknown as ApiChatAdapterContext & ApiChatResumeContext
    const stream = options.resume
        ? adapter.resumeMessage(context)
        : adapter.sendMessage(context, {
              id: 'user_message',
              role: 'user',
              contentBlocks: [{ type: 'text', text: 'fixture' }]
          } as unknown as ChatMessage)
    const events: EmittedChatEvent[] = []
    for await (const event of stream) events.push(event)
    return { events, calls, refs }
}
