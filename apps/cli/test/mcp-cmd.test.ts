import test from 'node:test'
import assert from 'node:assert/strict'
import { CommanderError } from 'commander'
import { parse as parseToml } from 'smol-toml'
import { json, runMf, type Route, type Run } from './fixtures/fake-api'
import { argvWantsJson } from '../src/output'

// `mf mcp`: an agent's MCP servers, kept per config scope of its framework
// (JSON text for Claude Code, TOML for Codex) and pushed to its machine.

const agentOf = (
    framework: string,
    mcp: Record<string, string> = {},
    extras: Record<string, unknown> = {}
) => ({
    id: 'agt_1',
    name: 'docs agent',
    framework,
    extras: { mcp, ...extras }
})

const delivered = (...scopes: string[]) =>
    json({
        agent: {},
        scopes: scopes.map((scopeId) => ({ scopeId, status: 'delivered' }))
    })

const routes = (
    agent: ReturnType<typeof agentOf>,
    over: Record<string, Route> = {}
): Record<string, Route> => ({
    'GET /agents/agt_1': () => json(agent),
    'PATCH /agents/agt_1': (call) =>
        json({
            ...agent,
            extras: { ...agent.extras, ...(call.body as object) }
        }),
    'POST /agents/agt_1/mcp/materialize': () => delivered('user', 'project'),
    ...over
})

const patched = (run: Run) =>
    run.calls.find((call) => call.method === 'PATCH')?.body as
        | { mcp: Record<string, string> }
        | undefined

const mcp = (...args: string[]) => ['mcp', ...args, '--agent-id', 'agt_1']

const claude = agentOf('claude-code', {
    user: '{"docs":{"command":"docs-mcp"}}',
    project: '{"kept":{"command":"kept-mcp"}}'
})

test('add: a server by URL goes into the first scope, the other scope kept, and is pushed', async () => {
    const run = await runMf(
        mcp(
            'add',
            'sentry',
            'https://mcp.sentry.dev/mcp',
            '--header',
            'Authorization: Bearer sk-live'
        ),
        routes(claude)
    )
    assert.equal(run.error, undefined, String(run.error))
    const body = patched(run)
    assert.ok(body)
    assert.deepEqual(JSON.parse(body.mcp.user), {
        docs: { command: 'docs-mcp' },
        sentry: {
            type: 'http',
            url: 'https://mcp.sentry.dev/mcp',
            headers: { Authorization: 'Bearer sk-live' }
        }
    })
    // An API that replaces the map whole must not lose the other scope.
    assert.equal(body.mcp.project, '{"kept":{"command":"kept-mcp"}}')
    assert.deepEqual(run.out, [
        '✓ added sentry in User (~/.claude.json) of agt_1'
    ])
    assert.deepEqual(run.err, ['written to ~/.claude.json'])
})

test('add: a server run as a command comes after --, its flags its own', async () => {
    const run = await runMf(
        [
            'mcp',
            'add',
            'pg',
            '--agent-id',
            'agt_1',
            '--scope',
            'project',
            '--env',
            'DATABASE_URL=postgres://app:pw@db/app',
            '--',
            'npx',
            '-y',
            '@modelcontextprotocol/server-postgres',
            '--json'
        ],
        routes(claude)
    )
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(JSON.parse(patched(run)!.mcp.project).pg, {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', '--json'],
        env: { DATABASE_URL: 'postgres://app:pw@db/app' }
    })
    // The --json after -- was the server's, not mf's.
    assert.match(run.out[0] ?? '', /^✓ added pg in Project/)
    assert.equal(
        argvWantsJson(['node', 'mf', 'mcp', 'add', 'x', '--', 'y', '--json']),
        false
    )
    assert.equal(argvWantsJson(['node', 'mf', '--json', 'mcp', 'list']), true)
})

test('add: a Codex agent gets a TOML table, after the servers it had', async () => {
    const codex = agentOf('codex', {
        global: '[mcp_servers.docs]\ncommand = "docs-mcp"'
    })
    const run = await runMf(
        // What comes after -- is the server's, so the agent comes before.
        [
            'mcp',
            'add',
            'pg',
            '--agent-id',
            'agt_1',
            '--env',
            'PGPASSWORD=a"b',
            '--',
            'npx',
            'pg-mcp'
        ],
        routes(codex, {
            'POST /agents/agt_1/mcp/materialize': () => delivered('global')
        })
    )
    assert.equal(run.error, undefined, String(run.error))
    const doc = parseToml(patched(run)!.mcp.global) as {
        mcp_servers: Record<string, Record<string, unknown>>
    }
    assert.deepEqual(Object.keys(doc.mcp_servers), ['docs', 'pg'])
    assert.deepEqual(doc.mcp_servers.pg, {
        command: 'npx',
        args: ['pg-mcp'],
        env: { PGPASSWORD: 'a"b' }
    })
    assert.deepEqual(run.err, ['written to ~/.codex/config.toml'])
})

test('add says what it needs before it writes anything', async () => {
    const cases: Array<[string[], RegExp]> = [
        [['add', 'pg'], /say how pg is reached: its URL/],
        [
            ['add', 'x', 'https://a.test/mcp', 'extra'],
            /takes the URL alone; for a command, put it after --/
        ],
        [
            ['add', 'x', 'https://a.test/mcp', '--env', 'A=b'],
            /--env goes with a server run as a command/
        ],
        [
            ['add', 'x', '--header', 'A: b', '--', 'npx', 'x'],
            /--header goes with a server reached by URL/
        ],
        [['add', 'Bad Name', 'https://a.test'], /a server's name is lowercase/],
        [
            ['add', 'x', 'https://a.test', '--header', 'no-colon'],
            /--header takes "Name: value"/
        ],
        [
            ['add', 'docs', 'https://a.test/mcp'],
            /already has a server named docs in User/
        ],
        [
            ['add', 'x', 'https://a.test', '--scope', 'global'],
            /--scope takes user or project/
        ]
    ]
    for (const [args, message] of cases) {
        const run = await runMf(mcp(...args), routes(claude))
        assert.ok(
            run.error instanceof CommanderError,
            `${args.join(' ')}: ${String(run.error)}`
        )
        assert.match(run.error.message, message, args.join(' '))
        assert.equal(patched(run), undefined, args.join(' '))
    }
    const openclaw = await runMf(
        mcp('add', 'x', 'https://a.test'),
        routes(agentOf('openclaw'))
    )
    assert.match(
        String(openclaw.error),
        /openclaw agents take no MCP servers from Manyfold; .*claude-code/
    )
})

test('list shows each scope and what reached the machine, and no secret values', async () => {
    const agent = agentOf(
        'claude-code',
        {
            user: JSON.stringify({
                search: {
                    type: 'http',
                    url: 'https://mcp.example.com/sse?key=url-secret',
                    headers: { Authorization: 'Bearer header-secret' }
                },
                pg: {
                    command: 'npx',
                    args: ['pg-mcp', 'postgres://app:arg-secret@db/app'],
                    env: { PGPASSWORD: 'env-secret' }
                }
            }),
            project: '{"broken":'
        },
        {
            composioConnectionId: 'uc_1',
            mcpDelivery: {
                user: { status: 'delivered', at: '2026-09-30T08:00:00Z' },
                project: {
                    status: 'failed',
                    message: 'Configuration saved; delivery is pending.',
                    at: '2026-09-30T08:00:00Z'
                }
            }
        }
    )
    const run = await runMf(mcp('list'), routes(agent))
    assert.equal(run.error, undefined, String(run.error))
    const text = run.out.join('\n')
    for (const secret of [
        'url-secret',
        'header-secret',
        'arg-secret',
        'env-secret'
    ])
        assert.ok(!text.includes(secret), `${secret} must not show`)
    assert.deepEqual(run.out, [
        'User  ~/.claude.json  on the machine',
        '  search  http  https://mcp.example.com/sse?…  headers: Authorization',
        '  pg  stdio  npx pg-mcp postgres://app:***@db/app  env: PGPASSWORD',
        "  composio  http  from the agent's Composio connection",
        'Project  <workspace>/.mcp.json  waiting to reach the machine',
        "  (its config does not parse; fix it in the web app's MCP settings of the agent)"
    ])
    const asJson = await runMf(mcp('list', '--json'), routes(agent))
    const scopes = JSON.parse(asJson.out.join('\n')).scopes as Array<{
        id: string
        servers: Array<{ name: string; env?: string[] }> | null
    }>
    assert.deepEqual(
        scopes.map((scope) => scope.id),
        ['user', 'project']
    )
    assert.deepEqual(scopes[0].servers?.[1], {
        name: 'pg',
        transport: 'stdio',
        command: 'npx',
        args: ['pg-mcp', 'postgres://app:***@db/app'],
        env: ['PGPASSWORD']
    })
    assert.equal(scopes[1].servers, null)
})

test('remove takes a server out of the scope that has it', async () => {
    const run = await runMf(mcp('remove', 'kept'), routes(claude))
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(patched(run)!.mcp, {
        user: '{"docs":{"command":"docs-mcp"}}',
        project: ''
    })
    assert.deepEqual(run.out, [
        '✓ removed kept from Project (<workspace>/.mcp.json) of agt_1'
    ])

    const codex = agentOf('codex', {
        global: '[mcp_servers.docs]\ncommand = "docs-mcp"\n\n[mcp_servers.pg]\ncommand = "pg-mcp"\n\n[mcp_servers.pg.env]\nA = "b"'
    })
    const toml = await runMf(
        mcp('remove', 'pg'),
        routes(codex, {
            'POST /agents/agt_1/mcp/materialize': () => delivered('global')
        })
    )
    assert.deepEqual(parseToml(patched(toml)!.mcp.global), {
        mcp_servers: { docs: { command: 'docs-mcp' } }
    })

    const both = agentOf('claude-code', {
        user: '{"x":{"command":"a"}}',
        project: '{"x":{"command":"b"}}'
    })
    const ambiguous = await runMf(mcp('remove', 'x'), routes(both))
    assert.ok(ambiguous.error instanceof CommanderError)
    assert.match(
        ambiguous.error.message,
        /x is in user and project; say which: --scope user/
    )
    const absent = await runMf(mcp('remove', 'nope'), routes(claude))
    assert.match(String(absent.error), /agt_1 has no MCP server named nope/)
    const managed = await runMf(
        mcp('remove', 'composio'),
        routes(agentOf('claude-code', {}, { composioConnectionId: 'uc_1' }))
    )
    assert.match(
        String(managed.error),
        /comes from the agent's Composio connection/
    )
    assert.equal(
        patched(ambiguous) ?? patched(absent) ?? patched(managed),
        undefined
    )
})

const libraryServer = {
    id: 'ums_1',
    serverKey: 'github',
    name: 'GitHub',
    description: null,
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer <token>' },
    createdAt: '2026-09-30T08:00:00Z',
    updatedAt: '2026-09-30T08:00:00Z'
}

test('install takes a server from your library first, then the catalog, filling its values in', async () => {
    const fromLibrary = await runMf(
        mcp('install', 'github', '--header', 'Authorization: Bearer ghp-real'),
        routes(claude, { 'GET /mcp/library': () => json([libraryServer]) })
    )
    assert.equal(fromLibrary.error, undefined, String(fromLibrary.error))
    assert.deepEqual(JSON.parse(patched(fromLibrary)!.mcp.user).github, {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ghp-real' }
    })
    assert.match(
        fromLibrary.out[0] ?? '',
        /installed \(from your MCP library\) github/
    )

    const fromCatalog = await runMf(
        mcp('install', 'context7', '--as', 'docs7'),
        routes(claude, {
            'GET /mcp/library': () => json([]),
            'GET /mcp/catalog/context7': () =>
                json({
                    id: 'context7',
                    name: 'Context7',
                    description: 'Library docs',
                    transport: 'stdio',
                    command: 'npx',
                    args: ['-y', '@upstash/context7-mcp'],
                    tags: [],
                    category: null,
                    featured: false,
                    homepageUrl: 'https://context7.com'
                })
        })
    )
    assert.equal(fromCatalog.error, undefined, String(fromCatalog.error))
    assert.deepEqual(JSON.parse(patched(fromCatalog)!.mcp.user).docs7, {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp']
    })

    const missing = await runMf(
        mcp('install', 'nothing'),
        routes(claude, { 'GET /mcp/library': () => json([]) })
    )
    assert.match(
        String(missing.error),
        /no MCP server nothing in your library or the catalog/
    )
})

test('a save says when the machine did not take it, and waits out a busy one', async () => {
    const skipped = await runMf(
        mcp('add', 'x', 'https://a.test/mcp'),
        routes(claude, {
            'POST /agents/agt_1/mcp/materialize': () =>
                json({
                    agent: {},
                    scopes: [
                        {
                            scopeId: 'user',
                            status: 'failed',
                            message:
                                'Configuration delivery failed; reconnect or retry the push.'
                        }
                    ]
                })
        })
    )
    assert.deepEqual(skipped.err, [
        'saved; not written to the machine: Configuration delivery failed; reconnect or retry the push.',
        'The machine gets it when its daemon next connects (a sleeping sandbox: when it starts); mf mcp push tries again now.'
    ])

    const busy = await runMf(
        mcp('add', 'x', 'https://a.test/mcp'),
        routes(claude, {
            'POST /agents/agt_1/mcp/materialize': () =>
                json(
                    { error: { code: 'DAEMON_CONFIG_BUSY', message: 'busy' } },
                    409
                )
        })
    )
    assert.equal(busy.error, undefined, String(busy.error))
    assert.deepEqual(busy.err, [
        'saved; another configuration push is using the machine, and this one follows it'
    ])

    // An API from before its wait answers a held machine at once.
    const older = await runMf(
        mcp('add', 'x', 'https://a.test/mcp'),
        routes(claude, {
            'POST /agents/agt_1/mcp/materialize': (_call, index) =>
                index === 0
                    ? json(
                          {
                              error: {
                                  code: 'bad_request',
                                  message: 'daemon configuration busy'
                              }
                          },
                          400
                      )
                    : delivered('user')
        })
    )
    assert.deepEqual(older.err, ['written to ~/.claude.json'])
    assert.equal(
        older.calls.filter((call) => call.path.endsWith('/materialize')).length,
        2
    )
})

test('pull reads the machine into Manyfold; push writes Manyfold to the machine', async () => {
    const pull = await runMf(
        mcp('pull'),
        routes(claude, {
            'POST /agents/agt_1/mcp/refresh': () =>
                json({
                    agent: {},
                    scopes: [
                        { scopeId: 'user', status: 'imported' },
                        {
                            scopeId: 'project',
                            status: 'skipped',
                            message: 'config file not found on the runtime'
                        }
                    ]
                })
        })
    )
    assert.deepEqual(pull.out, [
        'user  imported',
        'project  skipped  config file not found on the runtime'
    ])
    const push = await runMf(
        mcp('push'),
        routes(claude, {
            'POST /agents/agt_1/mcp/materialize': () =>
                json({
                    agent: {},
                    scopes: [
                        { scopeId: 'user', status: 'delivered' },
                        { scopeId: 'project', status: 'unchanged' }
                    ]
                })
        })
    )
    assert.deepEqual(push.out, [
        'User  written to ~/.claude.json',
        'Project  <workspace>/.mcp.json is up to date'
    ])
})

test('the catalog and your library, from the terminal', async () => {
    const list = await runMf(['mcp', 'catalog', 'list', '--q', 'git'], {
        'GET /mcp/catalog': (call) => {
            assert.equal(call.query.get('q'), 'git')
            return json({
                items: [
                    {
                        id: 'github',
                        name: 'GitHub',
                        transport: 'http',
                        description: 'Repos and PRs'
                    }
                ],
                nextCursor: null
            })
        }
    })
    assert.deepEqual(list.out, ['github  GitHub  http  Repos and PRs'])

    const created = await runMf(
        [
            'mcp',
            'library',
            'create',
            'pg',
            '--env',
            'PGPASSWORD=x',
            '--',
            'npx',
            'pg-mcp'
        ],
        {
            'POST /mcp/library': (call) =>
                json(
                    { ...libraryServer, id: 'ums_2', ...(call.body as object) },
                    201
                )
        }
    )
    assert.equal(created.error, undefined, String(created.error))
    assert.deepEqual(
        created.calls.find((call) => call.method === 'POST')?.body,
        {
            serverKey: 'pg',
            name: 'pg',
            transport: 'stdio',
            command: 'npx',
            args: ['pg-mcp'],
            env: { PGPASSWORD: 'x' }
        }
    )

    const updated = await runMf(
        [
            'mcp',
            'library',
            'update',
            'github',
            '--header',
            'Authorization: Bearer new'
        ],
        {
            'GET /mcp/library': () => json([libraryServer]),
            'PATCH /mcp/library/ums_1': (call) =>
                json({ ...libraryServer, ...(call.body as object) })
        }
    )
    assert.equal(updated.error, undefined, String(updated.error))
    assert.deepEqual(
        (
            updated.calls.find((call) => call.method === 'PATCH')?.body as {
                headers: unknown
            }
        ).headers,
        { Authorization: 'Bearer new' }
    )

    const refused = await runMf(['mcp', 'library', 'delete', 'github'], {})
    assert.ok(refused.error instanceof CommanderError)
    assert.match(refused.error.message, /without --yes/)
    const deleted = await runMf(
        ['mcp', 'library', 'delete', 'github', '--yes'],
        {
            'GET /mcp/library': () => json([libraryServer]),
            'DELETE /mcp/library/ums_1': () =>
                new Response(null, { status: 204 })
        }
    )
    assert.deepEqual(deleted.out, ['✓ deleted github'])
})
