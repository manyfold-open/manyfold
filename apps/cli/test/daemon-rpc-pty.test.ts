import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createObjectId } from '@manyfold/shared'
import { daemonActivitySnapshot, rpcHandler } from '../src/daemon/rpc'
import { resolvePtyBackend } from '../src/daemon/pty-backend'
import { ownedTerminalCount } from '../src/daemon/owned-terminals'
import type { RpcContext } from '../src/daemon/ws-client'

// A terminal the daemon owns, driven through the rpc handlers against a real
// pty (ADR-0029 §6): the stream that opened it detaches without killing it,
// a second pty.open with the same id attaches and gets the screen back, and
// pty.close by terminal id ends it for whoever is attached. Skipped where no
// pty backend is available (Bun's terminal or node-pty).

const ID = createObjectId('terminalSession')

interface Stream {
    ctx: RpcContext
    events: Array<[string, string]>
    cancel: () => void
    text: () => string
}

const stream = (refId: string): Stream => {
    const events: Array<[string, string]> = []
    let cancel = (): void => {}
    return {
        events,
        cancel: () => cancel(),
        text: () =>
            events
                .filter(([kind]) => kind === 'pty.out')
                .map(([, data]) => Buffer.from(data, 'base64').toString('utf8'))
                .join(''),
        ctx: {
            refId,
            sendEvent: (kind, data) => {
                events.push([kind, data])
            },
            onCancel: (handler) => {
                cancel = handler
            }
        }
    }
}

const waitFor = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 8_000
): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 25))
    }
}

const ptyAvailable = await resolvePtyBackend().then(
    () => true,
    () => false
)

test(
    'an owned terminal survives its stream, replays its screen to the next attachment and ends on pty.close',
    { skip: !ptyAvailable && 'no pty backend on this machine' },
    async () => {
        const base = await mkdtemp(join(tmpdir(), 'mf-rpc-pty-'))
        const priorConfigDir = process.env.MF_CONFIG_DIR
        const priorShell = process.env.SHELL
        process.env.MF_CONFIG_DIR = join(base, 'config')
        process.env.SHELL = '/bin/sh'
        try {
            const first = stream('ref-first')
            const opened = rpcHandler(
                'pty.open',
                {
                    terminalId: ID,
                    cols: 80,
                    rows: 24,
                    command: ['printf', 'marker-%s\\n', 'one'],
                    env: { PS1: '$ ' }
                },
                first.ctx
            )
            await waitFor(
                () => first.text().includes('marker-one'),
                'first output'
            )
            assert.deepEqual(first.events[0], [
                'pty.attach',
                JSON.stringify({ mode: 'spawned' })
            ])
            assert.equal(ownedTerminalCount(), 1)
            assert.equal(daemonActivitySnapshot().attachedTerminals, 1)

            await rpcHandler(
                'pty.input',
                {
                    refId: 'ref-first',
                    data: Buffer.from('echo marker-$((1+1))\n').toString(
                        'base64'
                    )
                },
                first.ctx
            )
            await waitFor(
                () => first.text().includes('marker-2'),
                'typed output'
            )

            // The stream's cancel detaches; the shell lives on, unattached.
            first.cancel()
            assert.deepEqual(await opened, {
                ok: true,
                payload: { detached: true }
            })
            assert.equal(ownedTerminalCount(), 1)
            assert.equal(daemonActivitySnapshot().attachedTerminals, 0)
            assert.equal(daemonActivitySnapshot().ownedTerminals, 1)

            const second = stream('ref-second')
            const reopened = rpcHandler(
                'pty.open',
                { terminalId: ID, cols: 100, rows: 30 },
                second.ctx
            )
            await waitFor(
                () => second.text().includes('marker-2'),
                'replayed screen'
            )
            assert.deepEqual(second.events[0], [
                'pty.attach',
                JSON.stringify({ mode: 'attached' })
            ])
            assert.ok(
                second.text().includes('marker-one'),
                'the whole screen comes back, not just the tail'
            )
            assert.equal(daemonActivitySnapshot().attachedTerminals, 1)

            // Closing by terminal id kills the process; the attachment
            // learns from the exit, not from a cancel.
            assert.deepEqual(
                await rpcHandler('pty.close', { terminalId: ID }, second.ctx),
                { ok: true }
            )
            const result = await reopened
            assert.equal(result.ok, true)
            assert.equal(typeof result.payload?.exitCode, 'number')
            await waitFor(() => ownedTerminalCount() === 0, 'registry empty')
            assert.equal(daemonActivitySnapshot().activePtys, 0)
        } finally {
            if (priorConfigDir === undefined) delete process.env.MF_CONFIG_DIR
            else process.env.MF_CONFIG_DIR = priorConfigDir
            if (priorShell === undefined) delete process.env.SHELL
            else process.env.SHELL = priorShell
        }
    }
)

test('a terminal id is validated before anything is spawned', async () => {
    const s = stream('ref-bad')
    assert.deepEqual(
        await rpcHandler(
            'pty.open',
            { terminalId: '../etc/passwd', cols: 80, rows: 24 },
            s.ctx
        ),
        { ok: false, error: 'invalid terminalId' }
    )
    assert.equal(s.events.length, 0)
})
