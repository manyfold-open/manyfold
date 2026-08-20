import type * as PtyTypes from 'node-pty'
import { loadPty } from './pty'

export interface PtySpawnOptions {
    shell: string
    args: string[]
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    onData(chunk: string | Uint8Array): void
}

export interface PtyProcess {
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
    exited: Promise<number>
}

export type PtyBackendName = 'bun' | 'node-pty'

export interface PtyBackend {
    name: PtyBackendName
    spawn(opts: PtySpawnOptions): PtyProcess
}

interface BunTerminal {
    write(data: string): void
    resize(cols: number, rows: number): void
    close(): void
}

interface BunPtySubprocess {
    exited: Promise<number | undefined>
    terminal: BunTerminal
    kill(signal?: string): void
}

interface BunPty {
    spawn(
        cmd: string[],
        opts: {
            cwd: string
            env: Record<string, string>
            terminal: {
                cols: number
                rows: number
                data(term: BunTerminal, chunk: Uint8Array): void
            }
        }
    ): BunPtySubprocess
}

const globalBun = (): unknown => (globalThis as { Bun?: unknown }).Bun

export const getBunPty = (
    value: unknown = globalBun(),
    platform: NodeJS.Platform = process.platform
): BunPty | null => {
    if (platform === 'win32') return null
    if (
        value &&
        typeof value === 'object' &&
        typeof (value as { Terminal?: unknown }).Terminal === 'function' &&
        typeof (value as { spawn?: unknown }).spawn === 'function'
    )
        return value as BunPty
    return null
}

export const createBunPtyBackend = (bun: BunPty): PtyBackend => ({
    name: 'bun',
    spawn: (opts) => {
        const env = { ...opts.env }
        if (!env.TERM) env.TERM = 'xterm-256color'
        let closed = false
        const proc = bun.spawn([opts.shell, ...opts.args], {
            cwd: opts.cwd,
            env,
            terminal: {
                cols: opts.cols,
                rows: opts.rows,
                data: (_term, chunk) => opts.onData(chunk)
            }
        })
        const closeTerminal = (): void => {
            if (closed) return
            closed = true
            try {
                proc.terminal.close()
            } catch {}
        }
        return {
            write: (data): void => proc.terminal.write(data),
            resize: (cols, rows): void => proc.terminal.resize(cols, rows),
            kill: (signal): void => {
                try {
                    proc.kill(signal)
                } catch {}
                closeTerminal()
            },
            exited: proc.exited.then((code) => {
                closeTerminal()
                return code ?? 0
            })
        }
    }
})

export const createNodePtyBackend = (mod: typeof PtyTypes): PtyBackend => ({
    name: 'node-pty',
    spawn: (opts) => {
        const term = mod.spawn(opts.shell, opts.args, {
            cwd: opts.cwd,
            env: opts.env,
            cols: opts.cols,
            rows: opts.rows,
            name: 'xterm-256color'
        })
        term.onData((chunk: string) => opts.onData(chunk))
        return {
            write: (data): void => term.write(data),
            resize: (cols, rows): void => term.resize(cols, rows),
            kill: (signal): void => term.kill(signal),
            exited: new Promise((resolveCode) =>
                term.onExit(({ exitCode }) => resolveCode(exitCode ?? 0))
            )
        }
    }
})

export const resolvePtyBackend = async (overrides?: {
    bun?: unknown
    platform?: NodeJS.Platform
    loadNodePty?: () => Promise<typeof PtyTypes>
}): Promise<PtyBackend> => {
    const platform = overrides?.platform ?? process.platform
    const bunGlobal = overrides?.bun ?? globalBun()
    const bun = getBunPty(bunGlobal, platform)
    if (bun) return createBunPtyBackend(bun)
    try {
        const mod = await (overrides?.loadNodePty ?? loadPty)()
        return createNodePtyBackend(mod)
    } catch (err) {
        throw new Error(
            ptyUnavailableMessage((err as Error).message, bunGlobal, platform)
        )
    }
}

export const ptyUnavailableMessage = (
    reason: string,
    bun: unknown,
    platform: NodeJS.Platform
): string => {
    if (bun !== undefined && platform === 'win32')
        return (
            'full terminal support is not available in Windows builds of mf.\n' +
            '  the web terminal runs in a limited pipe mode (no resize or job control).\n' +
            `  reason: ${reason}`
        )
    if (bun !== undefined)
        return (
            'this mf binary predates built-in terminal support.\n' +
            '  run `mf update` to get a binary with the built-in pty backend.\n' +
            `  reason: ${reason}`
        )
    return (
        'node-pty is required for terminal support when running mf under Node.\n' +
        '  install it with: npm i -g node-pty (needs python3 + make + g++ on Linux)\n' +
        `  reason: ${reason}`
    )
}

export const checkPtySupport = async (): Promise<
    { backend: PtyBackendName } | { problem: string }
> => {
    try {
        return { backend: (await resolvePtyBackend()).name }
    } catch (err) {
        return { problem: (err as Error).message }
    }
}

export const encodePtyChunk = (chunk: string | Uint8Array): string =>
    typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8').toString('base64')
        : Buffer.from(chunk).toString('base64')
