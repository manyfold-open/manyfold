import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const probeId = 'virtual:xterm-mode-query-probe'

test(
    'production xterm bundle answers the mode query used by Vim',
    { timeout: 15_000 },
    async () => {
        const result = await build({
            root: webRoot,
            configFile: resolve(webRoot, 'vite.config.ts'),
            logLevel: 'silent',
            plugins: [
                {
                    name: 'xterm-mode-query-probe',
                    resolveId(id) {
                        if (id === probeId) return `\0${probeId}`
                    },
                    load(id) {
                        if (id !== `\0${probeId}`) return
                        return `
                            import { Terminal } from '@xterm/xterm'
                            const terminal = new Terminal()
                            let reply = ''
                            terminal.onData((data) => { reply += data })
                            terminal.write('\\x1b[?2026$p', () => {
                                globalThis.__xtermModeQueryReply = reply
                            })
                        `
                    }
                }
            ],
            build: {
                write: false,
                rollupOptions: { input: probeId }
            }
        })
        const builds = Array.isArray(result) ? result : [result]
        const chunks = builds.flatMap((output) => {
            assert.ok('output' in output, 'expected a completed Vite build')
            return output.output.filter((item) => item.type === 'chunk')
        })
        assert.equal(chunks.length, 1)

        const runtime = globalThis as typeof globalThis & {
            __xtermModeQueryReply?: string
        }
        Object.defineProperties(runtime, {
            navigator: {
                configurable: true,
                value: { platform: 'Linux', userAgent: 'node' }
            },
            self: { configurable: true, value: runtime },
            window: { configurable: true, value: runtime }
        })

        // Vim sends this DECRQM probe during startup. The broken production
        // bundle threw inside requestMode(), so its callback never completed.
        await import(
            `data:text/javascript;base64,${Buffer.from(chunks[0].code).toString('base64')}`
        )
        await new Promise((resolve) => setTimeout(resolve, 20))

        assert.equal(runtime.__xtermModeQueryReply, '\x1b[?2026;2$y')
    }
)
