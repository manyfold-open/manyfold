import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import type { SpritesClient } from '../../src/client'
import { execSpriteStream, type ExecStreamHandle } from '../../src/exec-stream'
import type { ExecOptions } from '../../src/types'

export const runDetachProbe = async (
    client: SpritesClient,
    name: string,
    signal: AbortSignal,
    wait = (milliseconds: number) => delay(milliseconds, undefined, { signal })
): Promise<void> => {
    let active: ExecStreamHandle | undefined
    let ws: WebSocket | undefined
    const cancel = () => {
        ws?.terminate()
        active?.abort()
    }
    const exec = async (options: ExecOptions) => {
        signal.throwIfAborted()
        active = execSpriteStream(client, name, options)
        try {
            return await active.result
        } finally {
            active = undefined
        }
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
        signal.throwIfAborted()
        // ---- (a) detach survival: hard socket drop mid-command ----
        const script =
            'printf started > /tmp/mf_detach; sleep 20; printf done > /tmp/mf_detach'
        const params = new URLSearchParams()
        params.append('path', 'bash')
        for (const arg of ['bash', '-c', script]) params.append('cmd', arg)
        params.append('max_run_after_disconnect', '60s')
        params.append('stdin', 'true')
        const url = `${client.wsBaseUrl}/sprites/${encodeURIComponent(name)}/exec?${params.toString()}`
        ws = new WebSocket(url, {
            headers: client.authHeaderForInternalUse()
        })
        const socket = ws
        const session = async () => {
            while (true) {
                const [data, isBinary] = await once(socket, 'message', {
                    signal
                })
                if (isBinary) continue
                try {
                    const msg = JSON.parse(data.toString()) as {
                        type?: string
                    }
                    if (msg.type === 'session_info') return
                } catch {}
            }
        }
        await Promise.all([
            once(socket, 'open', { signal }).then(() =>
                socket.send(Buffer.from([0x04]))
            ),
            session()
        ])
        socket.terminate() // hard drop, no close handshake
        await wait(25_000) // sleep 20 completes inside the 60s window
        const survived = await exec({
            cmd: ['cat', '/tmp/mf_detach'],
            timeoutMs: 30_000
        })
        assert.equal(survived.stdout.trim(), 'done')

        // ---- (b) kill-on-abort despite a long detach window ----
        signal.throwIfAborted()
        const handle = (active = execSpriteStream(client, name, {
            cmd: ['bash', '-c', 'echo $$ > /tmp/mf_abort_pid; exec sleep 300'],
            timeoutMs: 60_000,
            maxRunAfterDisconnectSeconds: 120
        }))
        handle.result.catch(() => {})
        await wait(3_000) // session_info arrives right after exec start
        handle.abort()
        await wait(5_000) // SIGTERM propagation
        const check = await exec({
            cmd: [
                'bash',
                '-c',
                'kill -0 "$(cat /tmp/mf_abort_pid)" 2>/dev/null && echo alive || echo dead'
            ],
            timeoutMs: 30_000
        })
        assert.equal(check.stdout.trim(), 'dead')
    } finally {
        signal.removeEventListener('abort', cancel)
        cancel()
    }
}
