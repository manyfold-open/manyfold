import assert from 'node:assert/strict'
import test from 'node:test'
import { createClient } from '../src/client'

// A fetch stand-in that records the headers of every request it sees, so we can
// assert the account-scope header rides ALL transports (not just request()).
const capturing = (): { fetchImpl: typeof fetch; calls: Headers[] } => {
    const calls: Headers[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
        calls.push(new Headers(init?.headers))
        return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }
    return { fetchImpl, calls }
}

test('accountScope on: the central request() path sends x-account-scope', async () => {
    const { fetchImpl, calls } = capturing()
    const client = createClient({
        baseUrl: 'https://api.test',
        token: 't',
        accountScope: true,
        fetch: fetchImpl
    })
    await client.automations.list({})
    assert.equal(calls.at(-1)?.get('x-account-scope'), '1')
})

test('accountScope on: a manual fetch transport (files.read) also sends x-account-scope', async () => {
    // files.read builds its own Headers and calls fetchImpl directly — it must
    // still carry the header (B1: injected at the transport layer, not per-call).
    const { fetchImpl, calls } = capturing()
    const client = createClient({
        baseUrl: 'https://api.test',
        token: 't',
        accountScope: true,
        fetch: fetchImpl
    })
    await client.files.read('agt_a', '/x')
    assert.equal(calls.at(-1)?.get('x-account-scope'), '1')
})

test('files.write works in Node without XMLHttpRequest', async () => {
    assert.equal(typeof globalThis.XMLHttpRequest, 'undefined')
    const body = new TextEncoder().encode('hello from mf')
    let seen:
        | {
              url: string
              method: string | undefined
              headers: Headers
              body: BodyInit | null | undefined
          }
        | undefined
    const fetchImpl: typeof fetch = async (input, init) => {
        seen = {
            url: String(input),
            method: init?.method,
            headers: new Headers(init?.headers),
            body: init?.body
        }
        return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' }
        })
    }
    const client = createClient({
        baseUrl: 'https://api.test',
        token: 't',
        accountScope: true,
        fetch: fetchImpl
    })

    await client.files.write('agt_a', '/notes.txt', body)

    assert.equal(
        seen?.url,
        'https://api.test/agents/agt_a/files/write?path=%2Fnotes.txt'
    )
    assert.equal(seen?.method, 'PUT')
    assert.equal(seen?.headers.get('content-type'), 'application/octet-stream')
    assert.equal(seen?.headers.get('authorization'), 'Bearer t')
    assert.equal(seen?.headers.get('x-account-scope'), '1')
    assert.equal(seen?.body, body)
})

test('chat cancel scopes a delayed request to its assistant turn', async () => {
    let seen: string | undefined
    const fetchImpl: typeof fetch = async (input) => {
        seen = String(input)
        return new Response(null, { status: 204 })
    }
    const client = createClient({
        baseUrl: 'https://api.test',
        token: 't',
        fetch: fetchImpl
    })

    await client.chat.cancelStream('agent-1', 'session-1', 'message/1')

    assert.equal(
        seen,
        'https://api.test/agents/agent-1/sessions/session-1/cancel?assistantMessageId=message%2F1'
    )
})

test('accountScope off: no x-account-scope header is sent', async () => {
    const { fetchImpl, calls } = capturing()
    const client = createClient({
        baseUrl: 'https://api.test',
        token: 't',
        accountScope: false,
        fetch: fetchImpl
    })
    await client.automations.list({})
    assert.equal(calls.at(-1)?.get('x-account-scope'), null)
})
