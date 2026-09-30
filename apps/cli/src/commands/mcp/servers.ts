import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { McpConfigFormat, McpInstallableEntry } from '@manyfold/shared'
import { UsageError } from '@/usage-error'

// The MCP servers of one scope of an agent's config, in the text the
// framework keeps them in: a JSON object for Claude Code and Gemini CLI, a
// TOML document of [mcp_servers.<name>] tables for Codex.

type Servers = Record<string, Record<string, unknown>>

const isTable = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)

export const readServers = (format: McpConfigFormat, text: string): Servers => {
    const trimmed = text.trim()
    if (!trimmed) return {}
    const servers =
        format === 'json'
            ? (JSON.parse(trimmed) as unknown)
            : (parseToml(trimmed).mcp_servers ?? {})
    if (!isTable(servers)) throw new Error('not a table of servers')
    return Object.fromEntries(
        Object.entries(servers).map(([name, config]) => [
            name,
            isTable(config) ? config : {}
        ])
    )
}

// The scope's text without the server `name`; empty when it was the last.
export const withoutServer = (
    format: McpConfigFormat,
    text: string,
    name: string
): string => {
    if (format === 'json') {
        const { [name]: _gone, ...rest } = readServers('json', text)
        return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : ''
    }
    const doc = parseToml(text.trim())
    const { [name]: _gone, ...servers } = isTable(doc.mcp_servers)
        ? doc.mcp_servers
        : {}
    const { mcp_servers: _all, ...others } = doc
    const next =
        Object.keys(servers).length > 0
            ? { ...others, mcp_servers: servers }
            : others
    return Object.keys(next).length > 0 ? stringifyToml(next) : ''
}

// A server as `mf mcp list` shows it: what it is and where it runs, with
// the names of its headers and env but none of their values.
export interface McpServerView {
    name: string
    transport: 'http' | 'stdio'
    url?: string
    command?: string
    args?: string[]
    headers?: string[]
    env?: string[]
    // Injected from a Composio connection; not in the agent's own config.
    managed?: boolean
}

const keysOf = (value: unknown): string[] | undefined =>
    isTable(value) && Object.keys(value).length > 0
        ? Object.keys(value)
        : undefined

// A URL without what could be a credential: the userinfo, the query.
export const maskUrl = (value: string): string => {
    try {
        const url = new URL(value)
        if (url.origin === 'null') return value
        return `${url.origin}${url.pathname}${url.search ? '?…' : ''}`
    } catch {
        return value
    }
}

// An argument's `scheme://user:password@` loses the password.
const maskArg = (arg: string): string =>
    arg.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:***@')

export const serverView = (
    name: string,
    config: Record<string, unknown>
): McpServerView => {
    const url = [config.url, config.httpUrl, config.serverUrl].find(
        (value): value is string => typeof value === 'string'
    )
    const args = Array.isArray(config.args)
        ? config.args.map((arg) => maskArg(String(arg)))
        : undefined
    const headers = keysOf(config.headers ?? config.http_headers)
    const env = keysOf(config.env)
    return {
        name,
        transport: url ? 'http' : 'stdio',
        ...(url ? { url: maskUrl(url) } : {}),
        ...(typeof config.command === 'string'
            ? { command: config.command }
            : {}),
        ...(args?.length ? { args } : {}),
        ...(headers ? { headers } : {}),
        ...(env ? { env } : {})
    }
}

// What a library server or a catalog entry gives a scope, with --header /
// --env values put in (a catalog entry's are often placeholders).
export const withValues = (
    entry: McpInstallableEntry,
    flags: ServerFlags
): McpInstallableEntry => {
    const headers = parsePairs(flags.header, ':', '--header', '"Name: value"')
    const env = parsePairs(flags.env, '=', '--env', 'NAME=value')
    return {
        ...entry,
        ...(Object.keys(headers).length
            ? { headers: { ...entry.headers, ...headers } }
            : {}),
        ...(Object.keys(env).length ? { env: { ...entry.env, ...env } } : {})
    }
}

// The server names the library keys follow too.
const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export const assertServerName = (name: string): void => {
    if (!SERVER_NAME.test(name))
        throw new UsageError(
            `a server's name is lowercase letters, digits, - and _ (up to 64, starting with a letter or digit); got ${name}`
        )
}

export interface ServerFlags {
    header: string[]
    env: string[]
}

const parsePairs = (
    values: string[],
    separator: string,
    flag: string,
    shape: string
): Record<string, string> =>
    Object.fromEntries(
        values.map((value) => {
            const at = value.indexOf(separator)
            if (at <= 0)
                throw new UsageError(`${flag} takes ${shape}; got ${value}`)
            return [value.slice(0, at).trim(), value.slice(at + 1).trim()]
        })
    )

// A server from the command line, as `claude mcp add` takes one: its URL,
// or after `--` the command it runs as.
export const serverFromArgs = (
    name: string,
    target: string[],
    flags: ServerFlags
): McpInstallableEntry => {
    assertServerName(name)
    if (target.length === 0)
        throw new UsageError(
            `say how ${name} is reached: its URL (mf mcp add ${name} https://…), or after -- the command it runs as (mf mcp add ${name} -- npx -y <package>)`
        )
    if (/^https?:\/\//i.test(target[0])) {
        if (target.length > 1)
            throw new UsageError(
                `a server reached by URL takes the URL alone; for a command, put it after --: mf mcp add ${name} -- ${target.join(' ')}`
            )
        if (flags.env.length > 0)
            throw new UsageError(
                '--env goes with a server run as a command; one reached by URL takes --header'
            )
        return withValues(
            { id: name, name, transport: 'http', url: target[0] },
            flags
        )
    }
    if (flags.header.length > 0)
        throw new UsageError(
            '--header goes with a server reached by URL; one run as a command takes --env'
        )
    const [command, ...args] = target
    return withValues(
        {
            id: name,
            name,
            transport: 'stdio',
            command,
            ...(args.length > 0 ? { args } : {})
        },
        flags
    )
}
