import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { Command } from 'commander'
import { registerA2a } from '../src/commands/a2a'

for (const stage of [
    'discovery',
    'headers',
    'stream',
    'peers',
    'ticket'
] as const) {
    test(
        `send --stream deadline covers ${stage} and removes its SIGINT listener`,
        { timeout: 5000 },
        async (t) => {
            const errors: string[] = []
            const originalExitCode = process.exitCode
            t.mock.method(console, 'error', (line: string) => errors.push(line))
            t.mock.method(console, 'log', () => {})
            let rpcUrl = ''
            let stalledPath = ''
            const server = http.createServer((req, res) => {
                req.resume()
                if (stage === 'ticket' && req.url === '/agent-self/a2a/peers') {
                    res.setHeader('content-type', 'application/json')
                    res.end(
                        JSON.stringify([
                            {
                                agentId: 'target',
                                name: 'Peer',
                                rpcUrl,
                                cardUrl: ''
                            }
                        ])
                    )
                    return
                }
                stalledPath = req.url ?? ''
                if (stage === 'stream') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' })
                    res.write(': keepalive\n\n')
                }
            })
            server.listen(0, '127.0.0.1')
            await once(server, 'listening')
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
            rpcUrl = `${base}/rpc`
            const fallback = setTimeout(
                () => server.closeAllConnections(),
                3000
            )
            t.after(async () => {
                clearTimeout(fallback)
                process.exitCode = originalExitCode
                server.closeAllConnections()
                await new Promise<void>((resolve) =>
                    server.close(() => resolve())
                )
            })
            const listeners = process.listenerCount('SIGINT')
            const program = new Command()
                .exitOverride()
                .option('--api-url <url>')
                .option('--token <token>')
            registerA2a(program)
            const peer = stage === 'peers' || stage === 'ticket'
            await program.parseAsync(
                [
                    '--api-url',
                    base,
                    '--token',
                    'test-token',
                    'a2a',
                    'send',
                    peer ? 'Peer' : stage === 'discovery' ? base : rpcUrl,
                    'work',
                    '--stream',
                    '--allow-http-localhost',
                    '--timeout',
                    '0.2',
                    '--json'
                ],
                { from: 'user' }
            )
            assert.equal(process.exitCode, 1)
            assert.match(errors.join('\n'), /timed out after 0.2s/)
            assert.equal(process.listenerCount('SIGINT'), listeners)
            assert.equal(
                stalledPath,
                stage === 'peers'
                    ? '/agent-self/a2a/peers'
                    : stage === 'ticket'
                      ? '/agent-self/a2a/peers/target/token'
                      : stage === 'discovery'
                        ? '/.well-known/agent-card.json'
                        : '/rpc'
            )
        }
    )
}

test(
    'send --stream --timeout 0 accepts a delayed final message and cleans up',
    { timeout: 5000 },
    async (t) => {
        const lines: string[] = []
        t.mock.method(console, 'log', (line: string) => lines.push(line))
        t.mock.method(console, 'error', () => {})
        const server = http.createServer((req, res) => {
            req.resume()
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(': keepalive\n\n')
            const timer = setTimeout(
                () =>
                    res.end(
                        `data: ${JSON.stringify({
                            jsonrpc: '2.0',
                            id: 1,
                            result: {
                                kind: 'message',
                                messageId: 'm',
                                role: 'agent',
                                parts: [{ kind: 'text', text: 'answer' }]
                            }
                        })}\n\n`
                    ),
                250
            )
            res.on('close', () => clearTimeout(timer))
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        t.after(async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        })
        const listeners = process.listenerCount('SIGINT')
        const program = new Command().exitOverride()
        registerA2a(program)
        await program.parseAsync(
            [
                'a2a',
                'send',
                `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`,
                'work',
                '--stream',
                '--allow-http-localhost',
                '--timeout',
                '0'
            ],
            { from: 'user' }
        )
        assert.deepEqual(lines, ['answer'])
        assert.equal(process.listenerCount('SIGINT'), listeners)
    }
)
