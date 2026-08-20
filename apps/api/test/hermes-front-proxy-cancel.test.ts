import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse
} from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderHermesFrontProxyScript } from '../src/modules/agents/bootstrap/hermes-front-proxy'

const HANG_BUDGET_MS = 3_000
const RENDERED_PROXY = renderHermesFrontProxyScript()

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const withinBudget = <T>(
    promise: Promise<T>,
    message: string,
    budgetMs = HANG_BUDGET_MS
): Promise<T> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), budgetMs)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            (error: unknown) => {
                clearTimeout(timer)
                reject(error)
            }
        )
    })

const waitUntil = async (
    predicate: () => boolean,
    message: string
): Promise<void> => {
    const deadline = Date.now() + HANG_BUDGET_MS
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message)
        await sleep(20)
    }
}

interface Upstream {
    port: number
    requests: Array<{
        method: string
        url: string
        headers: IncomingMessage['headers']
    }>
    closed: Promise<void>
    close: () => Promise<void>
}

const startUpstream = async (
    onRequest: (req: IncomingMessage, res: ServerResponse) => void
): Promise<Upstream> => {
    const open = new Set<ServerResponse>()
    const requests: Upstream['requests'] = []
    let markClosed = (): void => {}
    const closed = new Promise<void>((resolve) => {
        markClosed = resolve
    })
    const server: Server = createServer((req, res) => {
        requests.push({
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers
        })
        open.add(res)
        res.on('error', () => {})
        res.on('close', () => {
            open.delete(res)
            markClosed()
        })
        req.resume()
        req.on('end', () => onRequest(req, res))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return {
        port,
        requests,
        closed,
        close: async () => {
            for (const res of open) res.destroy()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

const reservePort = async (): Promise<number> => {
    const probe = createTcpServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as { port: number }
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return port
}

const canConnect = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => {
            socket.destroy()
            resolve(true)
        })
        socket.once('error', () => resolve(false))
    })

interface Proxy {
    port: number
    stderr: () => string
    alive: () => boolean
    stop: () => Promise<void>
}

const startProxy = async (gatewayPort: number): Promise<Proxy> => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-front-proxy-'))
    const script = join(dir, 'mf-front-proxy.mjs')
    writeFileSync(script, RENDERED_PROXY)

    for (let attempt = 0; attempt < 3; attempt++) {
        const port = await reservePort()
        const child: ChildProcess = spawn(process.execPath, [script], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
                PATH: process.env.PATH ?? '',
                MF_PROXY_PORT: String(port),
                MF_GATEWAY_PORT: String(gatewayPort),
                MF_DASHBOARD_PORT: String(gatewayPort),
                MF_DASHBOARD_TOKEN: 'front-proxy-token'
            }
        })
        let stderr = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
            stderr += chunk
        })
        const closed = new Promise<void>((resolve) =>
            child.once('close', () => resolve())
        )
        const alive = (): boolean =>
            child.exitCode === null && child.signalCode === null
        const stopChild = async (): Promise<void> => {
            if (alive()) child.kill('SIGKILL')
            await closed
        }

        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && alive()) {
            if (await canConnect(port)) {
                await sleep(25)
                if (!alive()) break
                let stopped = false
                return {
                    port,
                    stderr: () => stderr,
                    alive,
                    stop: async () => {
                        if (stopped) return
                        stopped = true
                        await stopChild()
                        rmSync(dir, { recursive: true, force: true })
                    }
                }
            }
            await sleep(25)
        }

        const exitedEarly = !alive()
        await stopChild()
        const conflict = stderr.includes('EADDRINUSE')
        if (conflict && attempt < 2) continue
        rmSync(dir, { recursive: true, force: true })
        throw new Error(
            exitedEarly
                ? `proxy exited early: ${stderr}`
                : `proxy never listened on ${port}: ${stderr}`
        )
    }

    rmSync(dir, { recursive: true, force: true })
    throw new Error('proxy could not reserve a listening port')
}

const assertProxyHealthy = async (proxy: Proxy): Promise<void> => {
    await sleep(50)
    assert.ok(proxy.alive(), `proxy died: ${proxy.stderr()}`)
    assert.equal(proxy.stderr(), '')
}

const sseHeaders = (res: ServerResponse): void => {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
    })
}

const delta = (n: number): string =>
    `data: ${JSON.stringify({
        id: `chunk-${n}`,
        choices: [{ delta: { content: `t${n}` } }]
    })}\n\n`

const trickle = (
    res: ServerResponse,
    intervalMs: number,
    total: number | 'forever'
): (() => void) => {
    sseHeaders(res)
    let n = 0
    const timer = setInterval(() => {
        if (total !== 'forever' && n >= total) {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
            return
        }
        res.write(delta(++n))
    }, intervalMs)
    return () => clearInterval(timer)
}

const postChat = (proxy: Proxy, signal?: AbortSignal): Promise<Response> =>
    fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: 'Bearer key'
        },
        body: JSON.stringify({ model: 'hermes-agent', stream: true }),
        ...(signal ? { signal } : {})
    })

// WHY: the staging defect only converged locally. The gateway-side socket close
// proves that cancellation stops the Hermes generation behind the exact proxy.
test('front proxy: cancelling a gateway stream closes the proxy→gateway request', async () => {
    let stop = (): void => {}
    const gateway = await startUpstream((_req, res) => {
        stop = trickle(res, 50, 'forever')
    })
    const proxy = await startProxy(gateway.port)
    try {
        const controller = new AbortController()
        const response = await postChat(proxy, controller.signal)
        assert.equal(response.status, 200)
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        assert.equal((await reader.read()).done, false)
        const abortedAt = Date.now()
        controller.abort()

        await withinBudget(
            gateway.closed,
            'the gateway did not see the cancelled request close'
        )
        assert.ok(Date.now() - abortedAt < HANG_BUDGET_MS)
        await assertProxyHealthy(proxy)
    } finally {
        stop()
        await proxy.stop()
        await gateway.close()
    }
})

// WHY: a cancel may arrive after dispatch but before any gateway response byte.
test('front proxy: cancelling before the gateway responds closes the request too', async () => {
    const gateway = await startUpstream(() => {})
    const proxy = await startProxy(gateway.port)
    try {
        const controller = new AbortController()
        const pending = postChat(proxy, controller.signal).then(
            () => 'responded' as const,
            () => 'aborted' as const
        )
        await waitUntil(
            () => gateway.requests.length > 0,
            'the proxy never dispatched the gateway request'
        )
        controller.abort()

        assert.equal(
            await withinBudget(pending, 'the downstream fetch did not abort'),
            'aborted'
        )
        await withinBudget(
            gateway.closed,
            'the pre-header cancel did not close the gateway request'
        )
        await assertProxyHealthy(proxy)
    } finally {
        await proxy.stop()
        await gateway.close()
    }
})

// WHY: writableFinished must distinguish a complete stream from a cancellation.
test('front proxy: an uncancelled gateway stream completes through the proxy', async () => {
    let stop = (): void => {}
    const gateway = await startUpstream((_req, res) => {
        stop = trickle(res, 10, 3)
    })
    const proxy = await startProxy(gateway.port)
    try {
        const response = await postChat(proxy)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), 'text/event-stream')
        const body = await withinBudget(
            response.text(),
            'the normal gateway stream did not finish'
        )
        assert.deepEqual(
            [...body.matchAll(/"content":"(t\d)"/g)].map((match) => match[1]),
            ['t1', 't2', 't3']
        )
        assert.ok(body.endsWith('data: [DONE]\n\n'))
        assert.equal(gateway.requests.length, 1)
        assert.equal(gateway.requests[0]?.headers.origin, undefined)
        assert.equal(
            gateway.requests[0]?.headers.host,
            `127.0.0.1:${gateway.port}`
        )
        await assertProxyHealthy(proxy)
    } finally {
        stop()
        await proxy.stop()
        await gateway.close()
    }
})

// WHY: a reset after response headers cannot become a 502, but it must settle
// the downstream fetch instead of leaving it attached to a dead upstream body.
test('front proxy: an upstream response reset closes the partial downstream response', async () => {
    let reset = (): void => {}
    const gateway = await startUpstream((_req, res) => {
        sseHeaders(res)
        res.write(delta(1))
        reset = () => res.destroy()
    })
    const proxy = await startProxy(gateway.port)
    try {
        const response = await postChat(proxy)
        assert.equal(response.status, 200)
        const reader = (response.body as ReadableStream<Uint8Array>).getReader()
        assert.equal((await reader.read()).done, false)
        reset()
        let rejected = false
        const pending = reader.read().catch(() => {
            rejected = true
        })

        await withinBudget(
            pending,
            'the downstream body hung after the upstream response reset'
        )
        assert.ok(
            rejected,
            'a truncated upstream response must not look complete'
        )
        await assertProxyHealthy(proxy)
    } finally {
        await proxy.stop()
        await gateway.close()
    }
})

// WHY: connection failures occur before headers and still need a real 502.
test('front proxy: an unreachable upstream still answers 502', async () => {
    const deadPort = await reservePort()
    const proxy = await startProxy(deadPort)
    try {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/health`)
        assert.equal(response.status, 502)
        assert.equal(await response.text(), 'upstream unavailable')
        await assertProxyHealthy(proxy)
    } finally {
        await proxy.stop()
    }
})