import test from 'node:test'
import assert from 'node:assert/strict'
import { Command } from 'commander'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { registerA2a } from '../src/commands/a2a'
import {
    artifactText,
    buildA2aMessage,
    findSelfPeer,
    isHttpUrl,
    looksLikeRpcEndpoint,
    partsToText,
    resolveBearer,
    resolveInterfaceUrl
} from '../src/commands/a2a/helpers'
import type { AgentCard, Task } from '@manyfold/a2a'
import type { A2aSelfPeer } from '@manyfold/shared'
import { UsageError } from '../src/usage-error'
import { json, runMf } from './fixtures/fake-api'
import {
    buildAddCallerBody,
    parseExpiresInDays
} from '../src/commands/a2a/management'

const selfPeers: A2aSelfPeer[] = [
    {
        agentId: 'agt_target',
        name: 'Research Bot',
        cardUrl: 'https://h/api/a2a/agents/agt_target/agent-card.json',
        rpcUrl: 'https://h/api/a2a/agents/agt_target/rpc'
    }
]

for (const verb of ['call', 'stream', 'peers']) {
    test(`retired a2a ${verb} is rejected instead of dispatching a request`, async () => {
        const program = new Command().exitOverride().configureOutput({
            writeErr: () => {},
            writeOut: () => {}
        })
        registerA2a(program)
        await assert.rejects(
            program.parseAsync(['a2a', verb], { from: 'user' }),
            { code: 'commander.unknownCommand' }
        )
    })
}

test('findSelfPeer matches by agent id or name, case-insensitively', () => {
    assert.equal(findSelfPeer(selfPeers, 'agt_target')?.agentId, 'agt_target')
    assert.equal(findSelfPeer(selfPeers, 'research bot')?.agentId, 'agt_target')
    assert.equal(findSelfPeer(selfPeers, 'unknown'), undefined)
})

test('partsToText concatenates text parts and ignores others', () => {
    assert.equal(
        partsToText([
            { kind: 'text', text: 'a' },
            { kind: 'data', data: {} },
            { kind: 'text', text: 'b' }
        ]),
        'ab'
    )
})

test('artifactText joins artifact text', () => {
    const task: Task = {
        kind: 'task',
        id: 't1',
        contextId: 'c1',
        status: { state: 'completed' },
        artifacts: [
            { artifactId: 'a1', parts: [{ kind: 'text', text: 'hello' }] }
        ]
    }
    assert.equal(artifactText(task), 'hello')
})

test('task output retains a required-input prompt alongside its artifacts', () => {
    assert.equal(artifactText({
        kind: 'task', id: 't', contextId: 'c',
        status: { state: 'input-required', message: {
            kind: 'message', messageId: 'm', role: 'agent',
            parts: [{ kind: 'text', text: 'Confirm the draft?' }]
        } },
        artifacts: [{ artifactId: 'a', parts: [{ kind: 'text', text: 'Draft' }] }]
    }), 'Draft\nConfirm the draft?')
})

test('buildA2aMessage builds a user message carrying context/task/skill', () => {
    const message = buildA2aMessage('hi', {
        contextId: 'c1',
        taskId: 't1',
        skill: 's1'
    })
    assert.equal(message.kind, 'message')
    assert.equal(message.role, 'user')
    assert.equal(message.parts[0].kind, 'text')
    assert.equal(message.contextId, 'c1')
    assert.equal(message.taskId, 't1')
    assert.deepEqual(message.metadata, { skillId: 's1' })
    assert.ok(message.messageId.length > 0)
})

test('buildA2aMessage rejects empty input', () => {
    assert.throws(() => buildA2aMessage(undefined, {}))
})

test('looksLikeRpcEndpoint distinguishes rpc/a2a endpoints from base/card', () => {
    assert.equal(
        looksLikeRpcEndpoint('https://x.com/api/a2a/agents/ag1/rpc'),
        true
    )
    assert.equal(looksLikeRpcEndpoint('https://x.com/a2a'), true)
    assert.equal(looksLikeRpcEndpoint('https://x.com'), false)
    assert.equal(
        looksLikeRpcEndpoint('https://x.com/.well-known/agent-card.json'),
        false
    )
})

test('isHttpUrl splits raw urls (send/tasks target) from peer names', () => {
    assert.equal(isHttpUrl('https://x.com/a2a'), true)
    assert.equal(
        isHttpUrl('http://localhost:2222/api/a2a/agents/ag1/rpc'),
        true
    )
    assert.equal(isHttpUrl('research-bot'), false)
    assert.equal(isHttpUrl('agt_target'), false)
    assert.equal(isHttpUrl('ftp://x.com'), false)
    assert.equal(isHttpUrl(''), false)
})

test('resolveBearer prefers the literal flag, then the env var', () => {
    assert.equal(resolveBearer('tok'), 'tok')
    const prev = process.env.MF_A2A_BEARER
    process.env.MF_A2A_BEARER = 'envtok'
    assert.equal(resolveBearer(undefined), 'envtok')
    if (prev === undefined) delete process.env.MF_A2A_BEARER
    else process.env.MF_A2A_BEARER = prev
})

test('resolveInterfaceUrl resolves a relative interface URL against the card URL', () => {
    const absolute: AgentCard = {
        protocolVersion: '0.3.0',
        name: 'x',
        url: 'https://host.example.com/api/a2a/agents/ag1/rpc',
        preferredTransport: 'JSONRPC'
    }
    assert.equal(
        resolveInterfaceUrl(
            absolute,
            'https://host.example.com/.well-known/agent-card.json'
        ),
        'https://host.example.com/api/a2a/agents/ag1/rpc'
    )
    const relative: AgentCard = {
        protocolVersion: '0.3.0',
        name: 'x',
        url: '/api/a2a/agents/ag1/rpc',
        preferredTransport: 'JSONRPC'
    }
    assert.equal(
        resolveInterfaceUrl(
            relative,
            'https://host.example.com/.well-known/agent-card.json'
        ),
        'https://host.example.com/api/a2a/agents/ag1/rpc'
    )
})

test('A2A caller add requires exactly one explicit caller mode', () => {
    assert.deepEqual(
        buildAddCallerBody({
            external: true,
            name: '  zapier  ',
            expiresInDays: '7'
        }),
        {
            kind: 'external',
            name: 'zapier',
            expiresInDays: 7
        }
    )
    assert.deepEqual(
        buildAddCallerBody({
            callerAgentId: ' agt_peer ',
            replaceExisting: true
        }),
        {
            kind: 'peer',
            callerAgentId: 'agt_peer',
            expiresInDays: undefined,
            replaceExisting: true
        }
    )
    assert.throws(() => buildAddCallerBody({}), /exactly one/)
    assert.throws(
        () =>
            buildAddCallerBody({
                external: true,
                callerAgentId: 'agt_peer'
            }),
        /exactly one/
    )
})

test('A2A caller add validates mode-specific flags and expiry', () => {
    assert.equal(parseExpiresInDays(undefined), undefined)
    assert.equal(parseExpiresInDays('3'), 3)
    for (const value of ['0', '-1', '1.5', 'nope'])
        assert.throws(() => parseExpiresInDays(value), /positive integer/)
    assert.throws(
        () =>
            buildAddCallerBody({
                external: true,
                replaceExisting: true
            }),
        /only valid with --caller-agent-id/
    )
    assert.throws(
        () =>
            buildAddCallerBody({
                callerAgentId: 'agt_peer',
                name: 'not-valid'
            }),
        /only valid with --external/
    )
})

test('human streaming output contains the final artifact once; JSON preserves events', async () => {
    const artifact = (text: string, append: boolean) => ({
        kind: 'artifact-update',
        taskId: 't',
        contextId: 'c',
        artifact: { artifactId: 'a', parts: [{ kind: 'text', text }] },
        append
    })
    const events = [
        artifact('draft', true),
        artifact(' answer', true),
        artifact('draft answer', false),
        artifact('corrected', false),
        {
            kind: 'status-update',
            taskId: 't',
            contextId: 'c',
            status: { state: 'completed' },
            final: true
        }
    ]
    const server = http.createServer((req, res) => {
        req.resume()
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            for (const result of events)
                res.write(
                    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`
                )
            res.end()
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const log = console.log
    const error = console.error
    try {
        console.error = () => {}
        for (const json of [false, true]) {
            let output = ''
            console.log = (line: string) => {
                output += `${line}\n`
            }
            const program = new Command().exitOverride()
            registerA2a(program)
            await program.parseAsync(
                [
                    'a2a',
                    'send',
                    `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`,
                    'work',
                    '--stream',
                    '--allow-http-localhost',
                    ...(json ? ['--json'] : [])
                ],
                { from: 'user' }
            )
            if (json)
                assert.deepEqual(
                    output
                        .trim()
                        .split('\n')
                        .map((line) => JSON.parse(line)),
                    events
                )
            else assert.equal(output, 'corrected\n')
        }
    } finally {
        console.log = log
        console.error = error
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test('an --input-file that cannot be read is a usage error naming the flag', () => {
    assert.throws(
        () => buildA2aMessage('hi', { inputFile: '/nonexistent/doc.txt' }),
        (err: unknown) =>
            err instanceof UsageError &&
            /^--input-file: cannot read \/nonexistent\/doc\.txt \(ENOENT\)$/.test(
                err.message
            )
    )
})

test('a peer this agent holds no grant for exits 4 and points at mf a2a status', async () => {
    const run = await runMf(['--agent-id', 'agt_me', 'a2a', 'send', 'nobody', 'hi'], {
        'GET /agent-self/a2a/peers': () => json([])
    })
    assert.equal(run.exitCode, 4)
    const stderr = run.err.join('\n')
    assert.match(stderr, /no granted peer matching "nobody"/)
    assert.match(stderr, /mf a2a status lists the peers this agent may call/)
})

// ---- a task the peer hands over at its blocking cap (2026-10-01) ----
//
// A Manyfold peer answers a blocking send `working` at its blocking cap (a
// message/stream ends on that non-final frame) and keeps the task running.
// `send` used to print nothing and exit 0 there, and exited 0 on a failed task.

type PeerAnswer = { result: unknown } | { stream: unknown[] }

const sendToPeer = async (
    answer: (method: string) => PeerAnswer,
    args: string[] = []
) => {
    const methods: string[] = []
    const server = http.createServer((req, res) => {
        let raw = ''
        req.on('data', (chunk) => {
            raw += chunk
        })
        req.on('end', () => {
            const rpc = JSON.parse(raw) as { id: unknown; method: string }
            methods.push(rpc.method)
            const reply = answer(rpc.method)
            if ('stream' in reply) {
                res.writeHead(200, { 'content-type': 'text/event-stream' })
                for (const result of reply.stream)
                    res.write(
                        `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`
                    )
                res.end()
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(
                JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: reply.result })
            )
        })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`
    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    const previousExitCode = process.exitCode
    let exitCode: number | undefined
    console.log = (...values: unknown[]) => {
        out.push(values.map(String).join(' '))
    }
    console.error = (...values: unknown[]) => {
        err.push(values.map(String).join(' '))
    }
    process.exitCode = undefined
    try {
        const program = new Command().exitOverride()
        registerA2a(program)
        await program.parseAsync(
            ['a2a', 'send', url, 'work', '--allow-http-localhost', ...args],
            { from: 'user' }
        )
    } finally {
        exitCode =
            typeof process.exitCode === 'number' ? process.exitCode : undefined
        process.exitCode = previousExitCode
        console.log = log
        console.error = error
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    return { out, err: err.join('\n'), exitCode, methods, url }
}

const peerTask = (state: string, text?: string, message?: string) => ({
    kind: 'task',
    id: 'task-1',
    contextId: 'context-1',
    status: {
        state,
        ...(message
            ? {
                  message: {
                      kind: 'message',
                      messageId: 'status',
                      role: 'agent',
                      parts: [{ kind: 'text', text: message }]
                  }
              }
            : {})
    },
    artifacts: text
        ? [{ artifactId: 'a', parts: [{ kind: 'text', text }] }]
        : []
})

test('a blocking send answered working follows the task to its answer', async () => {
    const run = await sendToPeer((method) => ({
        result:
            method === 'message/send'
                ? peerTask('working')
                : peerTask('completed', 'the long answer')
    }))
    assert.equal(run.exitCode, undefined)
    assert.deepEqual(run.out, ['the long answer'])
    assert.match(run.err, /task-1 is still running on the peer; following it/)
    assert.deepEqual(run.methods, ['message/send', 'tasks/get'])
})

test('a send whose deadline passes while following exits 1 naming the running task', async () => {
    const run = await sendToPeer(() => ({ result: peerTask('working') }), [
        '--timeout',
        '1'
    ])
    assert.equal(run.exitCode, 1)
    assert.match(
        run.err,
        /timed out after 1s; task task-1 is still running on the peer/
    )
    assert.ok(
        run.err.includes(`track: mf a2a tasks get ${run.url} task-1 --wait`),
        run.err
    )
})

test('a send whose task ends failed prints why and exits 1', async () => {
    const run = await sendToPeer(() => ({
        result: peerTask(
            'failed',
            undefined,
            'delegated turn exceeded 7200s (detached cap)'
        )
    }))
    assert.equal(run.exitCode, 1)
    assert.deepEqual(run.out, [])
    assert.match(run.err, /delegated turn exceeded 7200s \(detached cap\)/)
})

test('a stream that ends before its task prints the followed answer, not the partial', async () => {
    for (const asJson of [false, true]) {
        const run = await sendToPeer(
            (method) =>
                method === 'message/stream'
                    ? {
                          stream: [
                              {
                                  kind: 'status-update',
                                  taskId: 'task-1',
                                  contextId: 'context-1',
                                  status: { state: 'working' },
                                  final: false
                              },
                              {
                                  kind: 'artifact-update',
                                  taskId: 'task-1',
                                  contextId: 'context-1',
                                  artifact: {
                                      artifactId: 'a',
                                      parts: [{ kind: 'text', text: 'part' }]
                                  },
                                  append: true
                              }
                          ]
                      }
                    : { result: peerTask('completed', 'part of the full answer') },
            ['--stream', ...(asJson ? ['--json'] : [])]
        )
        assert.equal(run.exitCode, undefined, `json=${asJson}`)
        if (asJson) {
            const last = JSON.parse(run.out.at(-1) ?? '{}')
            assert.equal(last.kind, 'task')
            assert.equal(last.status.state, 'completed')
        } else assert.deepEqual(run.out, ['part of the full answer'])
    }
})
