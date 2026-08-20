import test from 'node:test'
import assert from 'node:assert/strict'
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
