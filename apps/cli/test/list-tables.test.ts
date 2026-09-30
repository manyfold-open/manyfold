import test from 'node:test'
import assert from 'node:assert/strict'
import { json, runMf } from './fixtures/fake-api'

const minutesAgo = (minutes: number): string =>
    new Date(Date.now() - minutes * 60_000 - 1_000).toISOString()

const grant = (fields: object) => ({
    callerAgentId: null,
    callerAgentName: null,
    name: null,
    scopes: ['a2a:invoke'],
    createdAt: '2026-09-30T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    ...fields
})

const trace = (fields: object) => ({
    direction: 'outbound',
    targetAgentName: 'peer-agent',
    targetAgentId: 'agt_peer',
    callerAgentId: 'agt_me',
    callerAgentName: 'me',
    externalSubject: null,
    contextId: 'aac_1',
    chatSessionId: 'ses_1',
    userMessageId: null,
    assistantMessageId: null,
    usage: null,
    errorMessage: null,
    updatedAt: '2026-09-30T00:00:00.000Z',
    completedAt: null,
    ...fields
})

test('a2a callers list prints a table with a header', async () => {
    const run = await runMf(['--agent-id', 'agt_me', 'a2a', 'callers', 'list'], {
        'GET /agent-self/a2a/callers': () =>
            json([
                grant({
                    tokenId: 'tok_peer',
                    callerAgentId: 'agt_caller',
                    callerAgentName: 'test-agent',
                    name: 'auto-generated'
                }),
                grant({
                    tokenId: 'tok_ext',
                    name: 'ci',
                    expiresAt: '2020-01-01T00:00:00.000Z'
                }),
                grant({
                    tokenId: 'tok_ext2',
                    expiresAt: '2999-01-01T00:00:00.000Z'
                })
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'TOKEN ID  KIND      CALLER           EXPIRES',
        'tok_peer  peer      test-agent       never',
        'tok_ext   external  ci               expired 2020-01-01T00:00:00.000Z',
        'tok_ext2  external  External client  2999-01-01T00:00:00.000Z'
    ])
})

test('a2a tasks list prints a table with a header', async () => {
    const run = await runMf(['--agent-id', 'agt_me', 'a2a', 'tasks', 'list'], {
        'GET /agent-self/a2a/tasks': () =>
            json({
                tasks: [
                    trace({
                        id: 'aat_1',
                        state: 'completed',
                        createdAt: minutesAgo(5)
                    }),
                    trace({
                        id: 'aat_2',
                        state: 'failed',
                        targetAgentName: null,
                        targetAgentId: 'agt_other',
                        createdAt: minutesAgo(120)
                    })
                ],
                nextCursor: null
            })
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'ID     PEER        STATE      CREATED',
        'aat_1  peer-agent  completed  5m ago',
        'aat_2  agt_other   failed     2h ago'
    ])
})

test('a2a status puts its peers and in-flight calls in tables', async () => {
    const run = await runMf(['--agent-id', 'agt_me', 'a2a', 'status'], {
        'GET /agent-self/a2a/peers': () =>
            json([{ name: 'peer-agent', agentId: 'agt_peer' }]),
        'GET /agent-self/a2a/tasks': (call) => {
            assert.equal(call.query.get('state'), 'working')
            return json({
                tasks: [
                    trace({
                        id: 'aat_3',
                        state: 'working',
                        createdAt: minutesAgo(1)
                    })
                ],
                nextCursor: null
            })
        }
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'Callable peers (1)',
        '  NAME        AGENT ID',
        '  peer-agent  agt_peer',
        '\nIn-flight calls (1)',
        '  ID     PEER        STATE    CREATED',
        '  aat_3  peer-agent  working  1m ago'
    ])
})

test('backups list prints a table with a header', async () => {
    const run = await runMf(['backups', 'list'], {
        'GET /backups': () =>
            json([
                {
                    id: 'bak_1',
                    sourceAgentName: 'test-agent',
                    status: 'completed',
                    archiveBytes: 2048
                }
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'ID     AGENT       STATUS     SIZE',
        'bak_1  test-agent  completed  2048B'
    ])
})

test('runtime agents list prints a table with a header', async () => {
    const run = await runMf(['runtime', 'agents', 'list', 'rt_1'], {
        'GET /agent-runtimes/rt_1/framework-agents': () =>
            json([
                { id: 'agt_1', name: 'main', model: 'claude-opus-5-5' },
                { id: 'agt_2', name: 'helper', model: null }
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'ID     NAME    MODEL',
        'agt_1  main    claude-opus-5-5',
        'agt_2  helper'
    ])
})

test('skills repos list prints a table, or says it has none', async () => {
    const run = await runMf(['skills', 'repos', 'list'], {
        'GET /skills/repos': () =>
            json([
                {
                    id: 'repo_1',
                    owner: 'anthropics',
                    name: 'skills',
                    branch: 'main',
                    enabled: true,
                    readonly: false,
                    createdAt: null,
                    updatedAt: null
                }
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, ['ID      REPO', 'repo_1  anthropics/skills@main'])

    const none = await runMf(['skills', 'repos', 'list'], {
        'GET /skills/repos': () => json([])
    })
    assert.deepEqual(none.out, ['(no skill repos)'])
})

test('skills installed prints a table per agent, a failure under its row', async () => {
    const run = await runMf(['skills', 'installed'], {
        'GET /skills/installed': () =>
            json([
                {
                    agent: { id: 'agt_1', name: 'main' },
                    skills: [
                        {
                            id: 'usk_1',
                            installDir: '.claude/skills/pdf',
                            enabled: true,
                            materializeStatus: 'installed'
                        },
                        {
                            id: 'usk_2',
                            installDir: '.claude/skills/xlsx',
                            enabled: false,
                            materializeStatus: 'failed',
                            materializeError: 'disk full'
                        }
                    ]
                }
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'main (agt_1)',
        '  ID     DIR                  STATE',
        '  usk_1  .claude/skills/pdf   enabled',
        '  usk_2  .claude/skills/xlsx  disabled, materialize failed',
        '      disk full'
    ])
})

test('mcp library list prints a table and masks URL secrets', async () => {
    const run = await runMf(['mcp', 'library', 'list'], {
        'GET /mcp/library': () =>
            json([
                {
                    serverKey: 'pg',
                    name: 'Postgres',
                    transport: 'stdio',
                    command: 'npx',
                    args: ['pg-mcp']
                },
                {
                    serverKey: 'search',
                    name: 'Search',
                    transport: 'http',
                    url: 'https://mcp.example.com/sse?key=url-secret'
                }
            ])
    })
    assert.equal(run.error, undefined, String(run.error))
    assert.deepEqual(run.out, [
        'KEY     NAME      TRANSPORT  TARGET',
        'pg      Postgres  stdio      npx pg-mcp',
        'search  Search    http       https://mcp.example.com/sse?…'
    ])
})
