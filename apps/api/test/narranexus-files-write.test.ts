import assert from 'node:assert/strict'
import test from 'node:test'
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { narraNexusWrite } from '../src/modules/narranexus/narranexus-files-client'

// The gateway's only write entrypoint, and the one that turns chat attachments
// from "downloaded then dropped" into a file the agent can Read. It is reached
// exclusively from ChatApiFileService.ingestWorkspace — the user- and
// admin-facing controllers still gate on root.writable/maxUploadBytes, which
// stay closed for every NarraNexus root.

const TARGET = {
    ingressHost: 'gw.example.com',
    gatewayToken: 'tok',
    agentId: 'agent_5c8b62063217'
}

interface Captured {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: unknown
}

const withFetch = async (
    respond: () => { ok: boolean; status: number; text?: string },
    run: (captured: Captured[]) => Promise<void>
): Promise<void> => {
    const captured: Captured[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (url: string, init?: Captured) => {
        captured.push({ url, ...init })
        const r = respond()
        return {
            ok: r.ok,
            status: r.status,
            text: async () => r.text ?? ''
        }
    }) as never
    try {
        await run(captured)
    } finally {
        globalThis.fetch = orig
    }
}

test('narraNexusWrite POSTs the bytes to the agent-scoped files/write path', async () => {
    await withFetch(
        () => ({ ok: true, status: 200 }),
        async (captured) => {
            await narraNexusWrite(
                TARGET,
                '/home/sprite/.narranexus/data/workspaces/agent-1_mf_u/chat-attachments/s-1/uuid/cat.png',
                Buffer.from('binary'),
                { overwrite: true }
            )
            assert.equal(captured.length, 1)
            const [call] = captured
            assert.equal(call.method, 'POST')
            assert.ok(
                call.url.startsWith(
                    'https://gw.example.com/manyfold/agents/agent_5c8b62063217/files/write?path='
                ),
                `unexpected url: ${call.url}`
            )
            assert.ok(
                call.url.includes(
                    encodeURIComponent(
                        '/home/sprite/.narranexus/data/workspaces/agent-1_mf_u/chat-attachments/s-1/uuid/cat.png'
                    )
                ),
                'the path travels absolute, matching the list/stat/read helpers on the same router'
            )
            assert.ok(call.url.endsWith('&overwrite=true'))
            assert.equal(
                call.headers?.['content-type'],
                'application/octet-stream'
            )
            assert.equal(call.headers?.Authorization, 'Bearer tok')
        }
    )
})

// overwrite is false upstream and this is the only write door, so a caller that
// says nothing must not silently clobber an existing file.
test('narraNexusWrite does not ask for overwrite unless told to', async () => {
    await withFetch(
        () => ({ ok: true, status: 200 }),
        async (captured) => {
            await narraNexusWrite(TARGET, '/ws/a.txt', Buffer.from('x'))
            assert.ok(captured[0].url.endsWith('&overwrite=false'))
        }
    )
})

// prepareInboundFiles degrades a turn to text-only on a systemic failure and
// skips a single bad file otherwise; both need a typed throw rather than a
// silent success.
test('narraNexusWrite maps gateway refusals to typed errors', async () => {
    await withFetch(
        () => ({ ok: false, status: 403, text: 'workspace locked' }),
        async () => {
            await assert.rejects(
                narraNexusWrite(TARGET, '/ws/a.txt', Buffer.from('x')),
                (err: unknown) => err instanceof ForbiddenException
            )
        }
    )
    await withFetch(
        () => ({ ok: false, status: 404, text: 'no such agent' }),
        async () => {
            await assert.rejects(
                narraNexusWrite(TARGET, '/ws/a.txt', Buffer.from('x')),
                (err: unknown) => err instanceof NotFoundException
            )
        }
    )
    await withFetch(
        () => ({ ok: false, status: 500, text: 'boom' }),
        async () => {
            await assert.rejects(
                narraNexusWrite(TARGET, '/ws/a.txt', Buffer.from('x')),
                /status 500/
            )
        }
    )
})
