import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderMachineUpgradeEvent } from '@manyfold/shared'
import { createClient } from '../src/client'
import { ApiError } from '../src/errors'

// A machine upgrade streams NDJSON once the provider accepts it: the client
// skips keepalive lines, hands each event over, and returns the result; an
// error event or a refusal before the stream arrives as an ApiError.

const result = {
    outcome: 'completed',
    message: 'Upgrade complete',
    fromVersion: '0.0.1-rc44',
    targetVersion: '0.0.2',
    lastStep: 'completed'
}

const clientAnswering = (response: () => Response, sent: unknown[] = []) =>
    createClient({
        baseUrl: 'http://api.test/api',
        token: 'tok',
        fetch: async (url, init) => {
            sent.push({ url: String(url), body: init?.body })
            return response()
        }
    })

const ndjson = (...lines: string[]): Response =>
    new Response(lines.join('\n') + '\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' }
    })

test('an upgrade hands over each event and returns its result', async () => {
    const sent: unknown[] = []
    const client = clientAnswering(
        () =>
            ndjson(
                JSON.stringify({ type: 'accepted', fromVersion: '0.0.1-rc44' }),
                '',
                JSON.stringify({ type: 'step', step: 'starting_machine' }),
                JSON.stringify({ type: 'complete', result })
            ),
        sent
    )
    const events: ProviderMachineUpgradeEvent[] = []
    const got = await client.admin.runtimeProviders.machines.upgrade(
        'rtp_1',
        'sbx-a',
        { allowStorageMigration: true },
        (event) => events.push(event)
    )
    assert.deepEqual(got, result)
    assert.deepEqual(
        events.map((event) => event.type),
        ['accepted', 'step', 'complete']
    )
    assert.deepEqual(sent, [
        {
            url: 'http://api.test/api/admin/runtime-providers/rtp_1/machines/sbx-a/upgrade',
            body: JSON.stringify({ allowStorageMigration: true })
        }
    ])
})

test('an error event after the start is an ApiError with its code', async () => {
    const client = clientAnswering(() =>
        ndjson(
            JSON.stringify({ type: 'accepted', fromVersion: null }),
            JSON.stringify({
                type: 'error',
                code: 'PROVIDER_UNAVAILABLE',
                status: 503,
                message: 'sprites.dev is not answering'
            })
        )
    )
    await assert.rejects(
        client.admin.runtimeProviders.machines.upgrade(
            'rtp_1',
            'sbx-a',
            {},
            () => {}
        ),
        (err: unknown) =>
            err instanceof ApiError &&
            err.code === 'PROVIDER_UNAVAILABLE' &&
            err.status === 503
    )
})

test('a refusal before the stream is an ApiError a caller can branch on', async () => {
    const client = clientAnswering(
        () =>
            new Response(
                JSON.stringify({
                    ok: false,
                    error: {
                        code: 'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED',
                        message:
                            'this upgrade would move the sprite from sbd to juicefs storage'
                    }
                }),
                { status: 409 }
            )
    )
    await assert.rejects(
        client.admin.runtimeProviders.machines.upgrade(
            'rtp_1',
            'sbx-a',
            {},
            () => {}
        ),
        (err: unknown) =>
            err instanceof ApiError &&
            err.status === 409 &&
            err.code === 'PROVIDER_MACHINE_STORAGE_MIGRATION_REQUIRED'
    )
})
