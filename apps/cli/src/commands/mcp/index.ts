import type { Command } from 'commander'
import kleur from 'kleur'
import {
    frameworkMcpSupport,
    listFrameworks,
    mcpConfigFromExtras,
    mcpDeliveryFromExtras,
    mergeMcpServerIntoText,
    type AgentMcpDeliveryScopeResult,
    type AgentSummary,
    type CatalogSort,
    type FrameworkMcpSupport,
    type McpCatalogEntry,
    type McpInstallableEntry,
    type UserMcpServer
} from '@manyfold/shared'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import { resolveAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { limitOption } from '@/option-parsers'
import { emit, printJson } from '@/output'
import { formatTable, type TableCell } from '@/table'
import { UsageError } from '@/usage-error'
import {
    assertServerName,
    maskUrl,
    readServers,
    serverFromArgs,
    serverView,
    withoutServer,
    withValues,
    type McpServerView,
    type ServerFlags
} from '@/commands/mcp/servers'

// `mf mcp`: an agent's MCP servers, kept by Manyfold in each config scope
// of its framework and written into the machine's config files.

interface RootOpts {
    apiUrl?: string
    token?: string
}

interface AgentOpts {
    agentId?: string
    json?: boolean
}

interface EditOpts extends AgentOpts, ServerFlags {
    scope?: string
}

interface InstallOpts extends EditOpts {
    as?: string
}

interface CatalogOpts {
    q?: string
    category?: string
    sort?: string
    cursor?: string
    limit?: number
    json?: boolean
}

interface LibraryEditOpts extends ServerFlags {
    name?: string
    description?: string
    json?: boolean
}

// The API waits up to 20 s for a machine another push holds, and a push
// runs up to 90 s. One before that wait answered a held machine at once.
const PUSH_TIMEOUT_MS = 100_000
const BUSY_RETRY_MS = 20_000

const collect = (value: string, previous: string[]): string[] => [
    ...previous,
    value
]

type Scope = FrameworkMcpSupport['scopes'][number]

type Delivery =
    | { scopes: AgentMcpDeliveryScopeResult[] }
    | { busy: true }
    | { error: string }

const agentWithSupport = async (
    client: NcaClient,
    agentId: string
): Promise<{ agent: AgentSummary; support: FrameworkMcpSupport }> => {
    const agent = await client.agents.get(agentId)
    const support = frameworkMcpSupport(agent.framework)
    if (!support) {
        const readers = listFrameworks().filter((framework) =>
            frameworkMcpSupport(framework)
        )
        throw new Error(
            `${agent.framework} agents take no MCP servers from Manyfold; ${readers.join(', ')} agents do`
        )
    }
    return { agent, support }
}

const pickScope = (support: FrameworkMcpSupport, scope?: string): Scope => {
    if (scope === undefined) return support.scopes[0]
    const found = support.scopes.find((candidate) => candidate.id === scope)
    if (!found)
        throw new UsageError(
            `--scope takes ${support.scopes.map((candidate) => candidate.id).join(' or ')} for this agent`
        )
    return found
}

const serversOr = (
    support: FrameworkMcpSupport,
    text: string
): Record<string, Record<string, unknown>> | null => {
    try {
        return readServers(support.format, text)
    } catch {
        return null
    }
}

// Writes the saved config to the machine now, and returns how each scope went.
const pushNow = async (
    client: NcaClient,
    agentId: string
): Promise<Delivery> => {
    const giveUpAt = Date.now() + BUSY_RETRY_MS
    for (;;) {
        try {
            const res = await client.agents.materializeMcp(agentId, {
                signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
            })
            return { scopes: res.scopes }
        } catch (err) {
            if (!(err instanceof ApiError)) throw err
            if (err.code === 'DAEMON_CONFIG_BUSY') return { busy: true }
            if (err.status === 400 && /configuration busy/i.test(err.message)) {
                if (Date.now() > giveUpAt) return { busy: true }
                await new Promise((resolve) => setTimeout(resolve, 2_000))
                continue
            }
            if (err.status === 400)
                return { error: err.serverMessage ?? err.message }
            throw err
        }
    }
}

// The whole map, not the one scope: a server that replaced the map would
// drop the scopes left out.
const saveScope = async (
    client: NcaClient,
    agent: AgentSummary,
    scope: string,
    text: string
): Promise<Delivery> => {
    await client.agents.update(agent.id, {
        mcp: { ...mcpConfigFromExtras(agent.extras), [scope]: text }
    })
    return pushNow(client, agent.id)
}

const NOT_ON_MACHINE_HINT =
    'The machine gets it when its daemon next connects (a sleeping sandbox: when it starts); mf mcp push tries again now.'

// How a scope's push went, as one line (and when it did not land, why).
const deliveryLines = (scope: Scope, delivery: Delivery): string[] => {
    if ('busy' in delivery)
        return [
            kleur.yellow(
                'saved; another configuration push is using the machine, and this one follows it'
            )
        ]
    if ('error' in delivery)
        return [
            kleur.yellow(`saved; not written to the machine: ${delivery.error}`)
        ]
    const result = delivery.scopes.find((entry) => entry.scopeId === scope.id)
    if (!result) return [kleur.dim('saved')]
    if (result.status === 'delivered')
        return [kleur.green(`written to ${scope.path}`)]
    if (result.status === 'unchanged')
        return [kleur.green(`${scope.path} is up to date`)]
    return [
        kleur.yellow(
            `saved; not written to the machine: ${result.message ?? result.status}`
        ),
        kleur.dim(NOT_ON_MACHINE_HINT)
    ]
}

const deliveryJson = (delivery: Delivery): unknown =>
    'scopes' in delivery ? delivery.scopes : delivery

const writeServer = async (
    client: NcaClient,
    agentId: string,
    entry: McpInstallableEntry,
    opts: EditOpts,
    done: string
): Promise<void> => {
    const { agent, support } = await agentWithSupport(client, agentId)
    const scope = pickScope(support, opts.scope)
    const current = mcpConfigFromExtras(agent.extras)[scope.id] ?? ''
    const servers = serversOr(support, current)
    if (!servers)
        throw new Error(
            `the ${scope.label} config of ${agentId} does not parse; fix it in the web app's MCP settings of the agent`
        )
    if (entry.id in servers)
        throw new UsageError(
            `${agentId} already has a server named ${entry.id} in ${scope.label} (${scope.path}); mf mcp remove ${entry.id} first`
        )
    const text = mergeMcpServerIntoText(
        support.format,
        agent.framework,
        current,
        entry
    )
    const delivery = await saveScope(client, agent, scope.id, text)
    const view = serverView(
        entry.id,
        readServers(support.format, text)[entry.id] ?? {}
    )
    if (opts.json) {
        printJson({
            agentId,
            scope: scope.id,
            server: view,
            delivery: deliveryJson(delivery)
        })
        return
    }
    console.log(
        `${kleur.green('✓')} ${done} ${kleur.cyan(entry.id)} in ${scope.label} (${scope.path}) of ${agentId}`
    )
    for (const line of deliveryLines(scope, delivery)) console.error(line)
}

const target = (server: McpServerView): string =>
    server.url ?? [server.command ?? '', ...(server.args ?? [])].join(' ')

const serverRow = (server: McpServerView): TableCell[] => [
    [server.name, kleur.cyan],
    server.transport,
    server.managed
        ? ["from the agent's Composio connection", kleur.dim]
        : target(server),
    [server.headers?.join(', ') ?? '', kleur.dim],
    [server.env?.join(', ') ?? '', kleur.dim]
]

const PENDING = 'Configuration saved; delivery is pending.'

const deliveryNote = (
    record: { status: string; message?: string } | undefined
): string => {
    if (!record) return ''
    if (record.status === 'delivered') return kleur.dim('  on the machine')
    if (record.message === PENDING)
        return kleur.yellow('  waiting to reach the machine')
    return kleur.yellow(
        `  not on the machine: ${record.message ?? record.status}`
    )
}

const fromLibrary = (server: UserMcpServer): McpInstallableEntry => ({
    id: server.serverKey,
    name: server.name,
    transport: server.transport,
    url: server.url,
    headers: server.headers,
    command: server.command,
    args: server.args,
    env: server.env
})

const fromCatalog = (entry: McpCatalogEntry): McpInstallableEntry => ({
    id: entry.id,
    name: entry.name,
    transport: entry.transport,
    url: entry.url,
    headers: entry.headers,
    command: entry.command,
    args: entry.args,
    env: entry.env
})

// A server by its key: yours first (the web's "copy to library" keeps the
// catalog's key), then the platform catalog's.
const findServer = async (
    client: NcaClient,
    key: string
): Promise<{ entry: McpInstallableEntry; source: string }> => {
    const mine = (await client.mcp.library.list()).find(
        (server) => server.serverKey === key || server.id === key
    )
    if (mine) return { entry: fromLibrary(mine), source: 'your MCP library' }
    try {
        return {
            entry: fromCatalog(await client.mcp.catalogEntry(key)),
            source: 'the catalog'
        }
    } catch (err) {
        if (err instanceof ApiError && err.status === 404)
            throw new Error(
                `no MCP server ${key} in your library or the catalog (mf mcp library list, mf mcp catalog list)`
            )
        throw err
    }
}

const libraryServer = async (
    client: NcaClient,
    key: string
): Promise<UserMcpServer> => {
    const server = (await client.mcp.library.list()).find(
        (candidate) => candidate.serverKey === key || candidate.id === key
    )
    if (!server)
        throw new Error(
            `no MCP server ${key} in your library (mf mcp library list)`
        )
    return server
}

const withUsage =
    <A extends unknown[]>(
        cmd: Command,
        action: (...args: A) => Promise<void>
    ): ((...args: A) => Promise<void>) =>
    async (...args: A) => {
        try {
            await action(...args)
        } catch (err) {
            if (err instanceof UsageError) cmd.error(`error: ${err.message}`)
            throw err
        }
    }

const AGENT_HELP = 'agent whose servers these are (defaults to $MF_AGENT_ID)'
const SCOPE_HELP =
    "config scope it goes in (default: the framework's first; mf mcp list names them)"
const HEADER_HELP =
    '"Name: value" header for a server reached by URL (repeatable)'
const ENV_HELP = 'NAME=value for a server run as a command (repeatable)'

export const registerMcp = (program: Command): void => {
    const cmd = program
        .command('mcp')
        .description("Manage an agent's MCP servers")

    const client = async () =>
        (await buildClient(program.opts<RootOpts>())).client

    const list = cmd
        .command('list')
        .alias('ls')
        .description("List an agent's MCP servers, by config scope")
        .option('--agent-id <id>', AGENT_HELP)
        .option('--json', 'emit raw JSON', false)
    list.action(
        withUsage(list, async (opts: AgentOpts) => {
            const agentId = resolveAgentId(opts.agentId, program)
            const { agent, support } = await agentWithSupport(
                await client(),
                agentId
            )
            const stored = mcpConfigFromExtras(agent.extras)
            const delivery = mcpDeliveryFromExtras(agent.extras)
            const composio =
                typeof agent.extras?.composioConnectionId === 'string'
            const home = support.scopes.find((scope) =>
                scope.path.startsWith('~')
            )
            const scopes = support.scopes.map((scope) => {
                const read = serversOr(support, stored[scope.id] ?? '')
                const servers: McpServerView[] | null = read
                    ? Object.entries(read).map(([name, config]) =>
                          serverView(name, config)
                      )
                    : null
                if (servers && composio && scope.id === home?.id)
                    servers.push({
                        name: 'composio',
                        transport: 'http',
                        managed: true
                    })
                return {
                    id: scope.id,
                    label: scope.label,
                    path: scope.path,
                    delivery: delivery[scope.id] ?? null,
                    servers
                }
            })
            if (opts.json) {
                printJson({
                    agentId: agent.id,
                    framework: agent.framework,
                    scopes
                })
                return
            }
            for (const scope of scopes) {
                console.log(
                    `${kleur.bold(scope.label)}  ${kleur.dim(scope.path)}${deliveryNote(scope.delivery ?? undefined)}`
                )
                if (!scope.servers)
                    console.log(
                        kleur.yellow(
                            "  (its config does not parse; fix it in the web app's MCP settings of the agent)"
                        )
                    )
                else if (scope.servers.length === 0)
                    console.log(kleur.dim('  (none)'))
                else
                    for (const line of formatTable(
                        ['NAME', 'TRANSPORT', 'TARGET', 'HEADERS', 'ENV'],
                        scope.servers.map(serverRow)
                    ))
                        console.log(`  ${line}`)
            }
        })
    )

    const add = cmd
        .command('add <name> [target...]')
        .description(
            'Add an MCP server to an agent: its URL, or after -- the command it runs as'
        )
        .option('--agent-id <id>', AGENT_HELP)
        .option('--scope <scope>', SCOPE_HELP)
        .option('--header <header>', HEADER_HELP, collect, [])
        .option('--env <pair>', ENV_HELP, collect, [])
        .option('--json', 'emit raw JSON', false)
    add.action(
        withUsage(add, async (name: string, how: string[], opts: EditOpts) => {
            const entry = serverFromArgs(name, how, opts)
            const agentId = resolveAgentId(opts.agentId, program)
            await writeServer(await client(), agentId, entry, opts, 'added')
        })
    )

    const install = cmd
        .command('install <key>')
        .description(
            "Install a server from your MCP library or the platform's catalog on an agent"
        )
        .option(
            '--as <name>',
            'its name in the agent config (default: its key)'
        )
        .option('--agent-id <id>', AGENT_HELP)
        .option('--scope <scope>', SCOPE_HELP)
        .option(
            '--header <header>',
            `${HEADER_HELP}; fills in the entry's`,
            collect,
            []
        )
        .option(
            '--env <pair>',
            `${ENV_HELP}; fills in the entry's`,
            collect,
            []
        )
        .option('--json', 'emit raw JSON', false)
    install.action(
        withUsage(install, async (key: string, opts: InstallOpts) => {
            const agentId = resolveAgentId(opts.agentId, program)
            const api = await client()
            const found = await findServer(api, key)
            const entry = withValues(
                { ...found.entry, id: opts.as ?? found.entry.id },
                opts
            )
            assertServerName(entry.id)
            await writeServer(
                api,
                agentId,
                entry,
                opts,
                `installed (from ${found.source})`
            )
        })
    )

    const remove = cmd
        .command('remove <name>')
        .alias('rm')
        .description("Remove an MCP server from an agent's config")
        .option('--agent-id <id>', AGENT_HELP)
        .option('--scope <scope>', 'the config scope to remove it from')
        .option('--json', 'emit raw JSON', false)
    remove.action(
        withUsage(remove, async (name: string, opts: EditOpts) => {
            const agentId = resolveAgentId(opts.agentId, program)
            const api = await client()
            const { agent, support } = await agentWithSupport(api, agentId)
            const stored = mcpConfigFromExtras(agent.extras)
            const candidates = opts.scope
                ? [pickScope(support, opts.scope)]
                : support.scopes
            const holders = candidates.filter(
                (scope) =>
                    name in (serversOr(support, stored[scope.id] ?? '') ?? {})
            )
            if (holders.length === 0) {
                if (
                    name === 'composio' &&
                    typeof agent.extras?.composioConnectionId === 'string'
                )
                    throw new Error(
                        "composio comes from the agent's Composio connection; unlink the connection in the web app to drop it"
                    )
                throw new Error(
                    `${agentId} has no MCP server named ${name}${opts.scope ? ` in ${candidates[0].label}` : ''} (mf mcp list shows its servers)`
                )
            }
            if (holders.length > 1)
                throw new UsageError(
                    `${name} is in ${holders.map((scope) => scope.id).join(' and ')}; say which: --scope ${holders[0].id}`
                )
            const scope = holders[0]
            const text = withoutServer(
                support.format,
                stored[scope.id] ?? '',
                name
            )
            const delivery = await saveScope(api, agent, scope.id, text)
            if (opts.json) {
                printJson({
                    agentId,
                    scope: scope.id,
                    removed: name,
                    delivery: deliveryJson(delivery)
                })
                return
            }
            console.log(
                `${kleur.green('✓')} removed ${kleur.cyan(name)} from ${scope.label} (${scope.path}) of ${agentId}`
            )
            for (const line of deliveryLines(scope, delivery))
                console.error(line)
        })
    )

    const pull = cmd
        .command('pull')
        .description(
            "Read the MCP servers on the agent's machine into Manyfold (ones added there, e.g. with claude mcp add, that a push would replace)"
        )
        .option('--agent-id <id>', AGENT_HELP)
        .option('--json', 'emit raw JSON', false)
    pull.action(
        withUsage(pull, async (opts: AgentOpts) => {
            const agentId = resolveAgentId(opts.agentId, program)
            const res = await (
                await client()
            ).agents.refreshMcp(agentId, {
                signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
            })
            emit(opts, { agentId, scopes: res.scopes }, () => {
                for (const scope of res.scopes)
                    console.log(
                        `${scope.scopeId}  ${scope.status}${scope.message ? `  ${kleur.dim(scope.message)}` : ''}`
                    )
            })
        })
    )

    const push = cmd
        .command('push')
        .description(
            "Write the agent's MCP servers into its machine's config now"
        )
        .option('--agent-id <id>', AGENT_HELP)
        .option('--json', 'emit raw JSON', false)
    push.action(
        withUsage(push, async (opts: AgentOpts) => {
            const agentId = resolveAgentId(opts.agentId, program)
            const api = await client()
            const { support } = await agentWithSupport(api, agentId)
            const delivery = await pushNow(api, agentId)
            if (opts.json) {
                printJson({ agentId, delivery: deliveryJson(delivery) })
                return
            }
            for (const scope of support.scopes)
                console.log(
                    `${kleur.bold(scope.label)}  ${deliveryLines(scope, delivery).join('  ')}`
                )
        })
    )

    const catalog = cmd
        .command('catalog')
        .description('The MCP servers the platform offers')

    const catalogList = catalog
        .command('list')
        .alias('ls')
        .description('List catalog MCP servers')
        .option('--q <query>', 'search query')
        .option('--category <id>', 'only this category')
        .option('--sort <order>', "'featured' (default) or 'latest'")
        .option('--cursor <cursor>', 'opaque cursor from the previous page')
        .option('--limit <n>', 'page size (1-100, default 100)', limitOption(100))
        .option('--json', 'emit raw JSON', false)
    catalogList.action(
        withUsage(catalogList, async (opts: CatalogOpts) => {
            if (
                opts.sort !== undefined &&
                opts.sort !== 'featured' &&
                opts.sort !== 'latest'
            )
                throw new UsageError("--sort takes 'featured' or 'latest'")
            const page = await (
                await client()
            ).mcp.catalog({
                q: opts.q,
                category: opts.category,
                sort: opts.sort as CatalogSort | undefined,
                cursor: opts.cursor,
                limit: opts.limit ?? 100
            })
            if (opts.json) {
                printJson(page)
                return
            }
            if (page.items.length === 0)
                console.log(kleur.dim('(no MCP servers found)'))
            else
                for (const line of formatTable(
                    ['ID', 'NAME', 'TRANSPORT', 'DESCRIPTION'],
                    page.items.map((entry): TableCell[] => [
                        entry.id,
                        [entry.name, kleur.cyan],
                        entry.transport,
                        [entry.description, kleur.dim]
                    ])
                ))
                    console.log(line)
            if (page.nextCursor)
                console.error(
                    kleur.dim(
                        `(more — continue with --cursor ${page.nextCursor})`
                    )
                )
        })
    )

    const catalogGet = catalog
        .command('get <slug>')
        .description('Show a catalog MCP server: what installing it adds')
        .option('--json', 'emit raw JSON', false)
    catalogGet.action(
        withUsage(catalogGet, async (slug: string, opts: AgentOpts) => {
            const entry = await (await client()).mcp.catalogEntry(slug)
            emit(opts, entry, () => {
                console.log(
                    `${entry.id}  ${kleur.cyan(entry.name)}  ${entry.transport}`
                )
                console.log(`  ${entry.description}`)
                console.log(
                    `  ${entry.url ? maskUrl(entry.url) : [entry.command ?? '', ...(entry.args ?? [])].join(' ')}`
                )
                if (entry.headers && Object.keys(entry.headers).length)
                    console.log(
                        kleur.dim(
                            `  headers: ${Object.keys(entry.headers).join(', ')}`
                        )
                    )
                if (entry.env && Object.keys(entry.env).length)
                    console.log(
                        kleur.dim(`  env: ${Object.keys(entry.env).join(', ')}`)
                    )
                console.log(kleur.dim(`  ${entry.homepageUrl}`))
                console.error(
                    kleur.dim(
                        `install it: mf mcp install ${entry.id} --agent-id <agent> (--env / --header fill in its values)`
                    )
                )
            })
        })
    )

    const library = cmd
        .command('library')
        .description('Your MCP library: servers kept to install on any agent')

    const libraryList = library
        .command('list')
        .alias('ls')
        .description('List the servers in your MCP library')
        .option('--json', 'emit raw JSON', false)
    libraryList.action(
        withUsage(libraryList, async (opts: AgentOpts) => {
            const servers = await (await client()).mcp.library.list()
            emit(opts, servers, () => {
                if (servers.length === 0)
                    console.log(kleur.dim('(no MCP servers in your library)'))
                else
                    for (const line of formatTable(
                        ['KEY', 'NAME', 'TRANSPORT', 'TARGET'],
                        servers.map((server): TableCell[] => [
                            server.serverKey,
                            [server.name, kleur.cyan],
                            server.transport,
                            [
                                server.url
                                    ? maskUrl(server.url)
                                    : [
                                          server.command ?? '',
                                          ...(server.args ?? [])
                                      ].join(' '),
                                kleur.dim
                            ]
                        ])
                    ))
                        console.log(line)
            })
        })
    )

    const libraryCreate = library
        .command('create <key> [target...]')
        .description(
            'Keep a server in your library: its URL, or after -- the command it runs as'
        )
        .option('--name <name>', 'display name (default: the key)')
        .option('--description <text>', 'what it is for')
        .option('--header <header>', HEADER_HELP, collect, [])
        .option('--env <pair>', ENV_HELP, collect, [])
        .option('--json', 'emit raw JSON', false)
    libraryCreate.action(
        withUsage(
            libraryCreate,
            async (key: string, how: string[], opts: LibraryEditOpts) => {
                const entry = serverFromArgs(key, how, opts)
                const res = await (
                    await client()
                ).mcp.library.create({
                    serverKey: key,
                    name: opts.name ?? key,
                    ...(opts.description
                        ? { description: opts.description }
                        : {}),
                    transport: entry.transport,
                    ...(entry.url ? { url: entry.url } : {}),
                    ...(entry.headers ? { headers: entry.headers } : {}),
                    ...(entry.command ? { command: entry.command } : {}),
                    ...(entry.args ? { args: entry.args } : {}),
                    ...(entry.env ? { env: entry.env } : {})
                })
                emit(opts, res, () =>
                    console.log(
                        `${res.serverKey}  ${kleur.cyan(res.name)}  ${res.id}`
                    )
                )
            }
        )
    )

    const libraryUpdate = library
        .command('update <key> [target...]')
        .description(
            'Change a server in your library: a new URL or command replaces how it is reached; --header / --env add or change values'
        )
        .option('--name <name>', 'new display name')
        .option('--description <text>', 'new description')
        .option('--header <header>', HEADER_HELP, collect, [])
        .option('--env <pair>', ENV_HELP, collect, [])
        .option('--json', 'emit raw JSON', false)
    libraryUpdate.action(
        withUsage(
            libraryUpdate,
            async (key: string, how: string[], opts: LibraryEditOpts) => {
                const api = await client()
                const server = await libraryServer(api, key)
                const entry =
                    how.length > 0
                        ? serverFromArgs(server.serverKey, how, opts)
                        : withValues(fromLibrary(server), opts)
                if (
                    how.length === 0 &&
                    opts.header.length === 0 &&
                    opts.env.length === 0 &&
                    opts.name === undefined &&
                    opts.description === undefined
                )
                    throw new UsageError(
                        'nothing to change: pass a new URL or command, --header, --env, --name or --description'
                    )
                const http = entry.transport === 'http'
                const res = await api.mcp.library.update(server.id, {
                    ...(opts.name !== undefined ? { name: opts.name } : {}),
                    ...(opts.description !== undefined
                        ? { description: opts.description }
                        : {}),
                    transport: entry.transport,
                    url: http ? (entry.url ?? null) : null,
                    headers: http ? (entry.headers ?? null) : null,
                    command: http ? null : (entry.command ?? null),
                    args: http ? null : (entry.args ?? null),
                    env: http ? null : (entry.env ?? null)
                })
                emit(opts, res, () =>
                    console.log(
                        `${res.serverKey}  ${kleur.cyan(res.name)}  ${res.id}`
                    )
                )
            }
        )
    )

    const libraryDelete = library
        .command('delete <key>')
        .alias('rm')
        .description(
            'Delete a server from your library (agents it was installed on keep their copy)'
        )
        .option('-y, --yes', 'confirm deletion', false)
        .option('--json', 'output the result as JSON', false)
    libraryDelete.action(
        withUsage(
            libraryDelete,
            async (key: string, opts: AgentOpts & { yes?: boolean }) => {
                if (!opts.yes)
                    throw new UsageError(
                        `refusing to delete ${key} without --yes (or -y)`
                    )
                const api = await client()
                const server = await libraryServer(api, key)
                await api.mcp.library.delete(server.id)
                emit(opts, { ok: true, id: server.id }, () =>
                    console.log(kleur.dim(`✓ deleted ${server.serverKey}`))
                )
            }
        )
    )
}
