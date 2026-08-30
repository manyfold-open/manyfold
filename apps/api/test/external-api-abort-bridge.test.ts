import type { ChatMessage } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type {
    ApiChatAdapterContext,
    EmittedChatEvent
} from '../src/modules/chat/chat-adapter'
import {
    A2aChatAdapter,
    DifyChatAdapter
} from '../src/modules/chat/adapters/external-api.adapter'

process.env.MF_ALLOW_PRIVATE_EXTERNAL_PROVIDER_ENDPOINTS = '1'
// The real window is 5s; this only needs to be a bound the settle below
// outlasts, because the id harvester keeps reading after the consumer is gone.
const HARVEST_MS = 300
process.env.MF_UPSTREAM_CANCEL_HARVEST_MS = String(HARVEST_MS)
const SETTLE_MS = HARVEST_MS + 150

// #402. PR #652 taught the providers to do nothing when their signal is
// ALREADY aborted, but the adapter bridged `ctx.abortSignal` onto its private
// controller only AFTER awaiting the agent row and `providers.resolveForUser`.
// A signal never replays, so a cancel landing inside either await produced a
// live controller for a dead turn: Dify read the upload and POSTed
// /v1/chat-messages, A2A fetched the card and opened message/stream, and the
// local terminal converged to `cancelled_by_user` over an upstream task that
// was already generating and billing.
//
// Real node:http origins on purpose: "no upstream work exists" is only provable
// as an absence at the wire, and a provider-level test cannot reach this bridge
// at all — the race is entirely in what the adapter hands the provider.

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 2_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate() && Date.now() < deadline) await delay(5)
    assert.ok(predicate(), label)
}

// A pending await the test can hold open, so the cancel lands INSIDE the agent
// or provider lookup rather than before the call.
interface Gate {
    enter: () => Promise<void>
    entered: () => boolean
    release: () => void
}

const makeGate = (): Gate => {
    const state = { entered: false, release: (): void => {} }
    const held = new Promise<void>((resolve) => {
        state.release = resolve
    })
    return {
        enter: async () => {
            state.entered = true
            await held
        },
        entered: () => state.entered,
        release: () => state.release()
    }
}

interface Origin {
    endpointUrl: string
    hits: string[]
    close: () => Promise<void>
}

const startDifyOrigin = async (): Promise<Origin> => {
    const hits: string[] = []
    const server = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url}`)
        req.resume()
        req.on('end', () => {
            if (req.url?.endsWith('/files/upload')) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({ id: 'file-1', mime_type: 'text/plain' })
                )
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            // Terminated, not held open: a regressed no-start must fail on the
            // recorded hit rather than hang the suite.
            res.write(
                `data: ${JSON.stringify({
                    event: 'message',
                    task_id: 'task-7',
                    conversation_id: 'ctx-1',
                    answer: 'leaked'
                })}\n\n`
            )
            res.write(
                `data: ${JSON.stringify({
                    event: 'message_end',
                    conversation_id: 'ctx-1',
                    metadata: {}
                })}\n\n`
            )
            res.end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    return {
        endpointUrl: `http://127.0.0.1:${port}/v1`,
        hits,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

const startA2aOrigin = async (): Promise<Origin> => {
    const hits: string[] = []
    let base = ''
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = raw
                ? (JSON.parse(raw) as { id: string | number; method: string })
                : null
            hits.push(
                rpc
                    ? `${req.method} ${req.url} ${rpc.method}`
                    : `${req.method} ${req.url}`
            )
            if (req.url?.endsWith('/.well-known/agent-card.json')) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(
                    JSON.stringify({
                        protocolVersion: '0.3.0',
                        name: 'race',
                        url: `${base}/rpc`,
                        preferredTransport: 'JSONRPC'
                    })
                )
                return
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(
                `data: ${JSON.stringify({
                    jsonrpc: '2.0',
                    id: rpc?.id ?? 1,
                    result: {
                        kind: 'artifact-update',
                        taskId: 'task-7',
                        contextId: 'ctx-1',
                        artifact: {
                            artifactId: 'art-1',
                            parts: [{ kind: 'text', text: 'leaked' }]
                        },
                        append: true
                    }
                })}\n\n`
            )
            res.write(
                `data: ${JSON.stringify({
                    jsonrpc: '2.0',
                    id: rpc?.id ?? 1,
                    result: {
                        kind: 'status-update',
                        taskId: 'task-7',
                        contextId: 'ctx-1',
                        status: { state: 'completed' },
                        final: true
                    }
                })}\n\n`
            )
            res.end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
    return {
        endpointUrl: base,
        hits,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections()
                server.close(() => resolve())
            })
    }
}

class FakeDb {
    constructor(
        private readonly framework: 'dify' | 'a2a',
        private readonly gate?: Gate
    ) {}

    select() {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => {
                        if (this.gate) await this.gate.enter()
                        return [
                            {
                                id: 'agt_1',
                                userId: 'user_1',
                                extras: {
                                    externalBinding: {
                                        providerId: 'ueap_1',
                                        framework: this.framework,
                                        remoteRef:
                                            this.framework === 'dify'
                                                ? { userIdentifier: 'user_1' }
                                                : {}
                                    }
                                }
                            }
                        ]
                    }
                })
            })
        }
    }
}

class FakeProviders {
    constructor(
        private readonly framework: 'dify' | 'a2a',
        private readonly endpointUrl: string,
        private readonly gate?: Gate
    ) {}

    async resolveForUser() {
        if (this.gate) await this.gate.enter()
        return {
            provider: this.framework,
            endpointUrl: this.endpointUrl,
            apiKey: 'test-key',
            metadata: {}
        }
    }
}

class FakeChatRepo {
    async updateFrameworkSessionRef(): Promise<void> {}
}

// Counting `read` is what proves the "zero Dify file work" half: the adapter
// hands the provider a lazy closure, so a byte only leaves storage if the
// upload actually ran.
class FakeUploads {
    reads = 0

    async read(): Promise<AsyncIterable<Uint8Array>> {
        this.reads += 1
        return (async function* () {
            yield Buffer.from('x')
        })()
    }

    async delete(): Promise<void> {}
}

const ctx = (
    framework: 'dify' | 'a2a',
    abortSignal: AbortSignal
): ApiChatAdapterContext =>
    ({
        userId: 'user_1',
        agentId: 'agt_1',
        runtimeId: null,
        sessionId: 'cts_1',
        messageId: 'assistant-message-1',
        framework,
        runtimeKind: 'external',
        model: null,
        modelOverride: null,
        modelConfig: null,
        claudeCodePermissionMode: null,
        codexPermissionMode: null,
        hermesPermissionMode: null,
        frameworkSessionRef: null,
        history: [],
        abortSignal
    }) as ApiChatAdapterContext

const userMessage = (withUpload: boolean): ChatMessage => ({
    id: 'user-message-1',
    sessionId: 'cts_1',
    role: 'user',
    createdAt: '2026-06-16T09:00:00.000Z',
    contentBlocks: [
        { type: 'text', text: 'hello' },
        ...(withUpload
            ? [
                  {
                      type: 'upload' as const,
                      uploadId: 'cup_1',
                      name: 'a.txt',
                      contentType: 'text/plain',
                      size: 1
                  }
              ]
            : [])
    ]
})

interface Run {
    events: EmittedChatEvent[]
    uploads: FakeUploads
}

// One shape for both races: the gate holds either the agent read or the
// provider read open, the cancel lands while it is pending, and only then is
// the lookup released.
const runCancelledDuringLookup = async (
    framework: 'dify' | 'a2a',
    origin: Origin,
    gateOn: 'agent' | 'provider'
): Promise<Run> => {
    const gate = makeGate()
    const uploads = new FakeUploads()
    const db = new FakeDb(framework, gateOn === 'agent' ? gate : undefined)
    const providers = new FakeProviders(
        framework,
        origin.endpointUrl,
        gateOn === 'provider' ? gate : undefined
    )
    const Adapter = framework === 'dify' ? DifyChatAdapter : A2aChatAdapter
    const adapter = new Adapter(
        db as never,
        providers as never,
        new FakeChatRepo() as never,
        uploads as never
    )
    const controller = new AbortController()
    const events: EmittedChatEvent[] = []
    const consumed = (async () => {
        for await (const event of adapter.sendMessage(
            ctx(framework, controller.signal),
            userMessage(framework === 'dify')
        ))
            events.push(event)
    })()

    await waitFor(gate.entered, `expected the ${gateOn} lookup to start`)
    controller.abort()
    gate.release()
    await consumed
    // The harvester outlives the consumer, so an absence is only real once a
    // whole window has passed with the origin still untouched.
    await delay(SETTLE_MS)
    return { events, uploads }
}

const terminalTypes = (events: EmittedChatEvent[]): string[] =>
    events.map((event) => event.type)

test('dify starts no upstream work when the cancel lands during the agent lookup', async () => {
    const origin = await startDifyOrigin()
    try {
        const run = await runCancelledDuringLookup('dify', origin, 'agent')

        assert.deepEqual(
            origin.hits,
            [],
            `a turn cancelled during the agent read must never reach Dify; got ${JSON.stringify(origin.hits)}`
        )
        assert.equal(run.uploads.reads, 0, 'the upload must not even be read')
        assert.deepEqual(
            terminalTypes(run.events),
            ['done'],
            'the turn still terminalizes; chat.service maps it to cancelled_by_user'
        )
    } finally {
        await origin.close()
    }
})

test('dify starts no upstream work when the cancel lands during the provider lookup', async () => {
    const origin = await startDifyOrigin()
    try {
        const run = await runCancelledDuringLookup('dify', origin, 'provider')

        assert.deepEqual(
            origin.hits,
            [],
            `a turn cancelled during resolveForUser must never reach Dify; got ${JSON.stringify(origin.hits)}`
        )
        assert.equal(run.uploads.reads, 0, 'the upload must not even be read')
        assert.deepEqual(terminalTypes(run.events), ['done'])
    } finally {
        await origin.close()
    }
})

test('a2a fetches no card and opens no stream when the cancel lands during the agent lookup', async () => {
    const origin = await startA2aOrigin()
    try {
        const run = await runCancelledDuringLookup('a2a', origin, 'agent')

        assert.deepEqual(
            origin.hits,
            [],
            `a cancelled turn must not even resolve the agent card; got ${JSON.stringify(origin.hits)}`
        )
        assert.deepEqual(terminalTypes(run.events), ['done'])
    } finally {
        await origin.close()
    }
})

test('a2a fetches no card and opens no stream when the cancel lands during the provider lookup', async () => {
    const origin = await startA2aOrigin()
    try {
        const run = await runCancelledDuringLookup('a2a', origin, 'provider')

        assert.deepEqual(
            origin.hits,
            [],
            `a cancelled turn must not even resolve the agent card; got ${JSON.stringify(origin.hits)}`
        )
        assert.deepEqual(terminalTypes(run.events), ['done'])
    } finally {
        await origin.close()
    }
})

// WHY the two above are not vacuous: the same fixture, with nothing cancelled,
// has to reach the origin. An empty `hits` would otherwise also be what a
// broken server or a mis-wired adapter produces.
test('the same fixture reaches dify when nothing is cancelled', async () => {
    const origin = await startDifyOrigin()
    try {
        const uploads = new FakeUploads()
        const adapter = new DifyChatAdapter(
            new FakeDb('dify') as never,
            new FakeProviders('dify', origin.endpointUrl) as never,
            new FakeChatRepo() as never,
            uploads as never
        )
        const events: EmittedChatEvent[] = []
        for await (const event of adapter.sendMessage(
            ctx('dify', new AbortController().signal),
            userMessage(true)
        ))
            events.push(event)

        assert.deepEqual(origin.hits, [
            'POST /v1/files/upload',
            'POST /v1/chat-messages'
        ])
        assert.equal(uploads.reads, 1)
        assert.ok(events.some((event) => event.type === 'token'))
    } finally {
        await origin.close()
    }
})

test('the same fixture reaches a2a when nothing is cancelled', async () => {
    const origin = await startA2aOrigin()
    try {
        const adapter = new A2aChatAdapter(
            new FakeDb('a2a') as never,
            new FakeProviders('a2a', origin.endpointUrl) as never,
            new FakeChatRepo() as never
        )
        const events: EmittedChatEvent[] = []
        for await (const event of adapter.sendMessage(
            ctx('a2a', new AbortController().signal),
            userMessage(false)
        ))
            events.push(event)

        assert.deepEqual(origin.hits, [
            'GET /.well-known/agent-card.json',
            'POST /rpc message/stream'
        ])
        assert.ok(events.some((event) => event.type === 'token'))
    } finally {
        await origin.close()
    }
})
