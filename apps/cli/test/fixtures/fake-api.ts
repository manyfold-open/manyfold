import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { buildProgram } from '../../src/program'

// Runs `mf` in-process against a fake API: each request is recorded and
// answered by the route for its method and path (without the /api prefix),
// or a 404 envelope.

export interface Call {
    method: string
    path: string
    headers: Headers
    body: unknown
}

// `index` counts earlier calls to the same method and path.
export type Route = (call: Call, index: number) => Response

export const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const apiFetch =
    (routes: Record<string, Route>, calls: Call[]): typeof fetch =>
    async (input, init) => {
        const url = new URL(String(input))
        const method = init?.method ?? 'GET'
        const path = url.pathname.replace(/^\/api/, '')
        const call: Call = {
            method,
            path,
            headers: new Headers(init?.headers),
            body: init?.body ? JSON.parse(String(init.body)) : undefined
        }
        const index = calls.filter(
            (earlier) => earlier.method === method && earlier.path === path
        ).length
        calls.push(call)
        const route = routes[`${method} ${path}`]
        if (!route)
            return json(
                { error: { code: 'not_found', message: `${method} ${path}` } },
                404
            )
        return route(call, index)
    }

// What runCli sets up: usage errors throw instead of exiting the process.
const exitOverride = (command: Command, err: string[]): void => {
    command.exitOverride()
    command.configureOutput({
        writeErr: (text) => {
            err.push(text)
        }
    })
    for (const child of command.commands) exitOverride(child, err)
}

export interface Run {
    out: string[]
    err: string[]
    calls: Call[]
    // Whatever the command threw; a CommanderError for a usage error.
    error: unknown
    exitCode: number | undefined
}

// `env` values are set for the run, undefined ones removed.
export const runMf = async (
    args: string[],
    routes: Record<string, Route> = {},
    env: Record<string, string | undefined> = {}
): Promise<Run> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-fake-api-'))
    const previousFetch = globalThis.fetch
    const previousLog = console.log
    const previousErr = console.error
    const previousExitCode = process.exitCode
    const saved = new Map<string, string | undefined>()
    const setEnv = (name: string, value: string | undefined): void => {
        if (!saved.has(name)) saved.set(name, process.env[name])
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
    const out: string[] = []
    const err: string[] = []
    const calls: Call[] = []
    let error: unknown
    let exitCode: number | undefined
    globalThis.fetch = apiFetch(routes, calls)
    setEnv('MF_CONFIG_DIR', dir)
    setEnv('MF_PROFILE', 'test')
    setEnv('MF_API_TOKEN', 'nca_rt_env')
    for (const [name, value] of Object.entries(env)) setEnv(name, value)
    console.log = ((...values: unknown[]) => {
        out.push(values.map(String).join(' '))
    }) as typeof console.log
    console.error = ((...values: unknown[]) => {
        err.push(values.map(String).join(' '))
    }) as typeof console.error
    process.exitCode = undefined
    try {
        const program = buildProgram()
        exitOverride(program, err)
        await program.parseAsync(
            ['node', 'mf', '--api-url', 'https://api.test/api', ...args],
            { from: 'node' }
        )
    } catch (caught) {
        error = caught
    } finally {
        exitCode =
            typeof process.exitCode === 'number' ? process.exitCode : undefined
        process.exitCode = previousExitCode
        globalThis.fetch = previousFetch
        console.log = previousLog
        console.error = previousErr
        for (const [name, value] of saved) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
        await rm(dir, { recursive: true, force: true })
    }
    return { out, err, calls, error, exitCode }
}
