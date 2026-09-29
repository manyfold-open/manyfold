import { WebSocket } from 'ws'

// A stand-in for a machine's daemon in the storage fixtures: each exec is one
// websocket to the fixture server, which the test drives frame by frame —
// 0x01 stdout, 0x02 stderr, 0x03 exit code — exactly as the machine would
// answer. `online: false` is a daemon the API holds no socket to.
export const fixtureHostAccess = (
    wsOrigin: string,
    opts: { online?: boolean } = {}
) => {
    const online = opts.online !== false
    const exec = (req: {
        cmd: string[]
        timeoutMs: number
        onStdout?: (chunk: string) => void
    }) =>
        new Promise<{ exitCode: number; stdout: string; stderr: string }>(
            (resolve, reject) => {
                const url = new URL(`${wsOrigin}/exec`)
                for (const part of req.cmd) url.searchParams.append('cmd', part)
                const socket = new WebSocket(url)
                let stdout = ''
                let stderr = ''
                const timer = setTimeout(() => {
                    socket.terminate()
                    reject(new Error(`exec timed out after ${req.timeoutMs}ms`))
                }, req.timeoutMs)
                socket.on('message', (data, isBinary) => {
                    if (!isBinary) return
                    const buf = Buffer.isBuffer(data)
                        ? data
                        : Buffer.from(data as ArrayBuffer)
                    const body = buf.subarray(1).toString('utf8')
                    if (buf[0] === 0x01) {
                        stdout += body
                        req.onStdout?.(body)
                    } else if (buf[0] === 0x02) stderr += body
                    else if (buf[0] === 0x03) {
                        clearTimeout(timer)
                        socket.close()
                        resolve({ exitCode: buf[1] ?? 0, stdout, stderr })
                    }
                })
                socket.on('error', (err) => {
                    clearTimeout(timer)
                    reject(err)
                })
            }
        )
    return {
        ensure: async () => ({ daemon: null, online }),
        withHost: async <T>(
            _args: unknown,
            work: (session: { exec: typeof exec }) => Promise<T>
        ): Promise<T> => {
            if (!online) throw new Error('the fixture daemon is not reachable')
            return work({ exec })
        },
        hold: () => ({ release: async () => {} })
    }
}
