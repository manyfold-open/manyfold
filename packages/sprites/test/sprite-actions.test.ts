import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from 'node:http'
import { createClient } from '../src/client'
import { SpritesError } from '../src/errors'
import type { SpriteUpgradeEvent } from '../src/types'

// Restart and upgrade are routes the public OpenAPI does not list; these pin
// the shapes measured against sprites.dev (see SpriteRestart and
// SpriteUpgradeEvent) and what the watch does when the stream misbehaves.

interface Received {
    method: string
    path: string
    body: string
    headers: IncomingMessage['headers']
}

type Handler = (req: Received, res: ServerResponse) => void

const startServer = async (handler: Handler) => {
    const received: Received[] = []
    const server: Server = createServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
            const entry = {
                method: req.method ?? 'GET',
                path: req.url ?? '/',
                body,
                headers: req.headers
            }
            received.push(entry)
            handler(entry, res)
        })
    })
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
        received,
        client: createClient({
            token: 't',
            baseUrl: `http://127.0.0.1:${port}`
        }),
        close: () => {
            server.closeAllConnections()
            return new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

const line = (type: string, data: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ type, data, time: '2026-10-19T15:24:48Z' })}\n`

const streamOf = (res: ServerResponse): void => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
}

test('a restart is accepted with the machine it reboots', async () => {
    const s = await startServer((_req, res) =>
        json(res, 202, {
            message: 'Restart requested; the machine will reboot shortly.',
            machine_id: 'm-1',
            sprite_name: 'sbx-a'
        })
    )
    try {
        const result = await s.client.restartSprite('sbx-a')
        assert.equal(result.machine_id, 'm-1')
        assert.deepEqual(
            s.received.map((r) => `${r.method} ${r.path}`),
            ['POST /sprites/sbx-a/restart']
        )
    } finally {
        await s.close()
    }
})

test('a rate-limited request says how long sprites.dev asked to wait', async () => {
    const s = await startServer((_req, res) => {
        res.setHeader('Retry-After', '7')
        json(res, 429, { error: 'rate limited' })
    })
    try {
        await assert.rejects(
            s.client.restartSprite('sbx-a'),
            (err: unknown) =>
                err instanceof SpritesError &&
                err.code === 'quota' &&
                err.retryAfterMs === 7000
        )
    } finally {
        await s.close()
    }
})

test('an upgrade is watched across split lines to its completion', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        const all =
            line('started', {
                message: 'Starting upgrade',
                target_version: '0.0.2',
                previous_version: null
            }) +
            '\n' +
            'banner text that is not an event\n' +
            line('starting_machine') +
            line('completed', {
                message: 'Upgrade complete',
                target_version: '0.0.2'
            })
        // Cut mid-line, so an event arrives in pieces.
        res.write(all.slice(0, 37))
        setTimeout(() => res.end(all.slice(37)), 20)
    })
    try {
        let accepted = 0
        const events: SpriteUpgradeEvent[] = []
        const result = await s.client.upgradeSprite(
            'sbx-a',
            {},
            {
                onAccepted: () => (accepted += 1),
                onEvent: (event) => events.push(event)
            }
        )
        assert.deepEqual(result, {
            outcome: 'completed',
            targetVersion: '0.0.2',
            message: 'Upgrade complete',
            lastEvent: 'completed'
        })
        assert.equal(accepted, 1)
        assert.deepEqual(
            events.map((e) => e.type),
            ['started', 'starting_machine', 'completed']
        )
        // No options: no body, as the SDK sends it.
        assert.equal(s.received[0].body, '')
        assert.equal(s.received[0].headers.accept, 'application/x-ndjson')
    } finally {
        await s.close()
    }
})

test('only the options given are sent', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        res.end(line('skipped', { message: 'Upgrade skipped', reason: '' }))
    })
    try {
        const result = await s.client.upgradeSprite('sbx-a', {
            version: undefined,
            allow_storage_migration: true
        })
        assert.equal(result.outcome, 'skipped')
        assert.equal(result.message, 'Upgrade skipped')
        assert.deepEqual(JSON.parse(s.received[0].body), {
            allow_storage_migration: true
        })
    } finally {
        await s.close()
    }
})

test('a failed upgrade carries its reason, redacted', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        res.end(
            line('failed', {
                error: 'machine failed to start (Bearer abcdefghijklmnop0123)'
            })
        )
    })
    try {
        const result = await s.client.upgradeSprite('sbx-a')
        assert.equal(result.outcome, 'failed')
        assert.equal(result.message, 'machine failed to start ([REDACTED])')
    } finally {
        await s.close()
    }
})

test('a refusal before the stream rejects with the reason sprites.dev gave', async () => {
    const s = await startServer((_req, res) =>
        json(res, 409, {
            error: 'this upgrade would move the sprite from sbd to juicefs storage; retry with allow_storage_migration=true to migrate it',
            from_variant: 'sbd',
            to_variant: 'juicefs'
        })
    )
    try {
        let accepted = false
        await assert.rejects(
            s.client.upgradeSprite(
                'sbx-a',
                { version: '0.0.1-rc44' },
                { onAccepted: () => (accepted = true) }
            ),
            (err: unknown) =>
                err instanceof SpritesError &&
                err.code === 'conflict' &&
                err.status === 409 &&
                (err.body as { to_variant: string }).to_variant === 'juicefs'
        )
        assert.equal(accepted, false)
    } finally {
        await s.close()
    }
})

test('a stream that ends without a terminal event is incomplete, not failed', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        res.end(line('started') + line('starting_machine'))
    })
    try {
        const result = await s.client.upgradeSprite('sbx-a')
        assert.equal(result.outcome, 'incomplete')
        assert.equal(result.stoppedBecause, 'ended')
        assert.equal(result.lastEvent, 'starting_machine')
    } finally {
        await s.close()
    }
})

test('a stream that goes quiet is left after the idle bound', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        res.write(line('starting_machine'))
    })
    try {
        const result = await s.client.upgradeSprite(
            'sbx-a',
            {},
            { idleTimeoutMs: 100 }
        )
        assert.equal(result.outcome, 'incomplete')
        assert.equal(result.stoppedBecause, 'idle')
        assert.equal(result.lastEvent, 'starting_machine')
    } finally {
        await s.close()
    }
})

test('a stream that never ends is left after the overall bound', async () => {
    let tick: NodeJS.Timeout | undefined
    const s = await startServer((_req, res) => {
        streamOf(res)
        tick = setInterval(() => res.write('\n'), 20)
    })
    try {
        const result = await s.client.upgradeSprite(
            'sbx-a',
            {},
            { timeoutMs: 150, idleTimeoutMs: 1_000 }
        )
        assert.equal(result.outcome, 'incomplete')
        assert.equal(result.stoppedBecause, 'timeout')
    } finally {
        clearInterval(tick)
        await s.close()
    }
})

test('aborting the watch after acceptance leaves the upgrade running', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        res.write(line('updating_machine'))
    })
    try {
        const controller = new AbortController()
        const result = await s.client.upgradeSprite(
            'sbx-a',
            {},
            {
                signal: controller.signal,
                onEvent: () => controller.abort()
            }
        )
        assert.equal(result.outcome, 'incomplete')
        assert.equal(result.stoppedBecause, 'aborted')
    } finally {
        await s.close()
    }
})

test('a stream past the size bound is left unread', async () => {
    const s = await startServer((_req, res) => {
        streamOf(res)
        const filler = `${'x'.repeat(1023)}\n`
        for (let i = 0; i < 1100; i++) res.write(filler)
        res.end(line('completed'))
    })
    try {
        const result = await s.client.upgradeSprite('sbx-a')
        assert.equal(result.outcome, 'incomplete')
        assert.equal(result.stoppedBecause, 'too_large')
    } finally {
        await s.close()
    }
})
