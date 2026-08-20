import assert from 'node:assert/strict'
import test from 'node:test'
import { WebSocket } from 'ws'
import { createClient } from '../../src/client'
import { execSprite } from '../../src/exec'
import { execSpriteStream } from '../../src/exec-stream'

const RUN_E2E = process.env.RUN_SPRITES_E2E === '1'

const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// Live regression for #211 against real sprites.dev. Two legs:
//  (a) a raw WSS drop (transient disconnect) must NOT kill the process when
//      max_run_after_disconnect is set — the work completes after disconnect;
//  (b) SDK abort() (intentional cancel) must kill the session promptly even
//      though the detach window is long.
test(
    'detach e2e: disconnected exec survives its window, abort kills promptly',
    { timeout: 180_000 },
    async (t) => {
        if (!RUN_E2E) {
            t.skip('set RUN_SPRITES_E2E=1 to run')
            return
        }
        const token = process.env.SPRITES_TOKEN
        assert.ok(token, 'SPRITES_TOKEN is required when RUN_SPRITES_E2E=1')
        const client = createClient({ token })
        const name = `nca-probe-detach-${Date.now()}`
        await client.createSprite({ name })
        try {
            // ---- (a) detach survival: hard socket drop mid-command ----
            const script =
                'printf started > /tmp/mf_detach; sleep 20; printf done > /tmp/mf_detach'
            const params = new URLSearchParams()
            params.append('path', 'bash')
            for (const arg of ['bash', '-c', script]) params.append('cmd', arg)
            params.append('max_run_after_disconnect', '60s')
            params.append('stdin', 'true')
            const url = `${client.wsBaseUrl}/sprites/${encodeURIComponent(name)}/exec?${params.toString()}`
            const ws = new WebSocket(url, {
                headers: client.authHeaderForInternalUse()
            })
            await new Promise<void>((resolve, reject) => {
                ws.on('open', () => resolve())
                ws.on('error', reject)
            })
            ws.send(Buffer.from([0x04])) // stdin EOF
            await new Promise<void>((resolve) => {
                ws.on('message', (data, isBinary) => {
                    if (isBinary) return
                    try {
                        const msg = JSON.parse(data.toString()) as {
                            type?: string
                        }
                        if (msg.type === 'session_info') resolve()
                    } catch {}
                })
            })
            ws.terminate() // hard drop, no close handshake
            await delay(25_000) // sleep 20 completes well inside the 60s window
            const survived = await execSprite(client, name, {
                cmd: ['cat', '/tmp/mf_detach'],
                timeoutMs: 30_000
            })
            assert.equal(survived.stdout.trim(), 'done')

            // ---- (b) kill-on-abort despite a long detach window ----
            const handle = execSpriteStream(client, name, {
                cmd: [
                    'bash',
                    '-c',
                    'echo $$ > /tmp/mf_abort_pid; exec sleep 300'
                ],
                timeoutMs: 60_000,
                maxRunAfterDisconnectSeconds: 120
            })
            handle.result.catch(() => {})
            await delay(3_000) // session_info arrives right after exec start
            handle.abort()
            await delay(5_000) // SIGTERM propagation
            const check = await execSprite(client, name, {
                cmd: [
                    'bash',
                    '-c',
                    'kill -0 "$(cat /tmp/mf_abort_pid)" 2>/dev/null && echo alive || echo dead'
                ],
                timeoutMs: 30_000
            })
            assert.equal(check.stdout.trim(), 'dead')
        } finally {
            await client.deleteSprite(name).catch(() => {})
        }
    }
)
