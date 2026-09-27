import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import postgres from 'postgres'
import { CONCURRENT_INDEXES } from '../src/db/concurrent-index'
import { runJournal } from '../src/db/migration-runner'
import { withScratchDatabase } from '../scripts/scratch-db'

// ADR-0036 cutover (migration 0027). The mapping from the old model — runner
// hosts found by name, per-framework projections, token purposes, agent copies
// — to the new one is set-based SQL, so it is proven here against a real
// Postgres: a scratch database is migrated up to 0026, seeded in the old shape,
// and then the cutover runs. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/adr36-cutover.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'
const FOLDER = path.join(process.cwd(), 'drizzle')
const CUTOVER_TAG = '0027_host_runtime_daemon_model'
const TABLE = '__drizzle_migrations'

type Sql = ReturnType<typeof postgres>

const connect = (url: string): Sql =>
    postgres(url, { max: 1, onnotice: () => undefined })

// The journal with the cutover removed: what a database looked like before.
const journalBefore = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adr36-journal-'))
    cpSync(FOLDER, dir, { recursive: true })
    const journalPath = path.join(dir, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: Array<{ tag: string }>
    }
    journal.entries = journal.entries.filter((e) => e.tag !== CUTOVER_TAG)
    writeFileSync(journalPath, JSON.stringify(journal))
    unlinkSync(path.join(dir, `${CUTOVER_TAG}.sql`))
    return dir
}

const apply = async (url: string, folder: string): Promise<void> => {
    const client = connect(url)
    try {
        await runJournal(client, {
            folder,
            migrationsTable: TABLE,
            concurrentIndexes: CONCURRENT_INDEXES
        })
    } finally {
        await client.end()
    }
}

const seedBefore = async (sql: Sql): Promise<void> => {
    await sql`insert into plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb)
        values ('pgtest-adr36', 'pgtest-adr36', 5, 5, 10)`
    await sql`insert into users (id, email, plan_id) values ('usr_adr36', 'adr36@pgtest.local', 'pgtest-adr36')`
    await sql`insert into sprites_accounts (id, slug, org_slug, org_id, token_id, token_ciphertext, token_key_version, status, priority, notes)
        values ('spa_adr36', 'org-adr36', 'org', 'o1', 't1', 'enc-sprites', 2, 'enabled', 3, 'noted')`
    await sql`insert into k8s_clusters (id, name, description, kubeconfig_ciphertext, kubeconfig_key_version, host_suffix, region, last_health_status, last_health_message, priority)
        values ('clus_adr36', 'cluster-adr36', 'desc', 'enc-kube', 1, 'suffix.local', 'eu', 'ok', 'fine', 1)`

    const hosts = [
        // the sandbox the runner lives in
        {
            id: 'sbx_adr36', kind: 'sandbox', managed: false, name: 'sandbox-001',
            status: 'active', account_id: 'spa_adr36', sprite_name: 'sprite-adr36',
            sprite_id: 'spid', sprite_status: 'warm', terminal_enabled: true,
            daemon_uuid: null, cli_version: null, rpc_last_seen_at: null,
            last_seen_at: null, created_at: sql`now() - interval '3 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        // its runner: the newer of a twin pair
        {
            id: 'dh_runner_new', kind: 'daemon', managed: true, name: 'sprite-runner:sprite-adr36',
            status: 'active', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-new', cli_version: '4.8.0',
            rpc_last_seen_at: sql`now()`, last_seen_at: sql`now()`, created_at: sql`now() - interval '1 day'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        {
            id: 'dh_runner_old', kind: 'daemon', managed: true, name: 'sprite-runner:sprite-adr36',
            status: 'offline', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-old', cli_version: '4.6.1',
            rpc_last_seen_at: sql`now() - interval '1 day'`, last_seen_at: sql`now() - interval '1 day'`,
            created_at: sql`now() - interval '2 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        // a self-owned computer, currently offline
        {
            id: 'dh_laptop', kind: 'daemon', managed: false, name: 'laptop',
            status: 'offline', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-laptop', cli_version: '4.8.0',
            rpc_last_seen_at: null, last_seen_at: sql`now() - interval '1 hour'`, created_at: sql`now() - interval '10 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        // a revoked self-owned computer
        {
            id: 'dh_revoked', kind: 'daemon', managed: false, name: 'old-box',
            status: 'revoked', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-revoked', cli_version: '4.6.1',
            rpc_last_seen_at: null, last_seen_at: null, created_at: sql`now() - interval '30 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        // a cloud computer and its runner
        {
            id: 'pdh_adr36', kind: 'pod', managed: false, name: 'cloud-001',
            status: 'active', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: null, cli_version: null,
            rpc_last_seen_at: null, last_seen_at: null, created_at: sql`now() - interval '2 days'`,
            cluster_id: 'clus_adr36', namespace: 'ns-adr36', ingress_host: 'ing.local',
            pod_status: 'ready', pod_phase: 'Running', pod_failure_reason: null
        },
        {
            id: 'dh_podrunner', kind: 'daemon', managed: true, name: 'pod-runner:pdh_adr36',
            status: 'active', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-pod', cli_version: '4.8.0',
            rpc_last_seen_at: sql`now()`, last_seen_at: sql`now()`, created_at: sql`now() - interval '2 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        },
        // a runner whose sandbox row is gone
        {
            id: 'dh_orphan', kind: 'daemon', managed: true, name: 'sprite-runner:gone',
            status: 'offline', account_id: null, sprite_name: null, sprite_id: null, sprite_status: null,
            terminal_enabled: false, daemon_uuid: 'uuid-orphan', cli_version: '0.24.0',
            rpc_last_seen_at: null, last_seen_at: sql`now() - interval '40 days'`, created_at: sql`now() - interval '50 days'`,
            cluster_id: null, namespace: null, ingress_host: null, pod_status: null, pod_phase: null, pod_failure_reason: null
        }
    ]
    for (const h of hosts)
        await sql`insert into runtime_hosts (id, user_id, kind, managed, name, status, account_id, sprite_name, sprite_id, sprite_status, terminal_enabled, daemon_uuid, cli_version, rpc_last_seen_at, last_seen_at, created_at, cluster_id, namespace, ingress_host, pod_status, pod_phase, pod_failure_reason, home_dir, workspace_base_dir, detected_frameworks, client_features)
            values (${h.id}, 'usr_adr36', ${h.kind}, ${h.managed}, ${h.name}, ${h.status}, ${h.account_id}, ${h.sprite_name}, ${h.sprite_id}, ${h.sprite_status}, ${h.terminal_enabled}, ${h.daemon_uuid}, ${h.cli_version}, ${h.rpc_last_seen_at}, ${h.last_seen_at}, ${h.created_at}, ${h.cluster_id}, ${h.namespace}, ${h.ingress_host}, ${h.pod_status}, ${h.pod_phase}, ${h.pod_failure_reason}, '/home/x', '/home/x/.manyfold/workspaces', '[{"framework":"codex","version":"1.0.0","path":"/x"}]'::jsonb, '["exec.resume"]'::jsonb)`

    const tokens = [
        ['ldt_laptop', 'dh_laptop', 'user', 'h1'],
        ['ldt_runner_new', 'dh_runner_new', 'sprite_runner', 'h2'],
        ['ldt_runner_old', 'dh_runner_old', 'sprite_runner', 'h3'],
        ['ldt_pod', 'dh_podrunner', 'pod_runner', 'h4'],
        ['ldt_orphan', 'dh_orphan', 'sprite_runner', 'h5'],
        ['ldt_unbound_platform', null, 'sprite_runner', 'h6'],
        ['ldt_unbound_user', null, 'user', 'h7']
    ] as const
    for (const [id, daemonId, purpose, hash] of tokens)
        await sql`insert into daemon_tokens (id, user_id, daemon_id, name, purpose, token_hash)
            values (${id}, 'usr_adr36', ${daemonId}, ${id}, ${purpose}, ${hash})`

    const runtimes = [
        ['art_sprite_codex', 'sprites', 'codex', 'ready', null, 'sbx_adr36', null, true, 'spa_adr36', 'sprite-adr36'],
        ['art_sprite_codex_failed', 'sprites', 'codex', 'failed', 'install blew up', 'sbx_adr36', null, false, 'spa_adr36', 'sprite-adr36'],
        ['art_proj_claude', 'daemon', 'claude-code', 'ready', null, null, 'dh_runner_new', false, null, null],
        ['art_proj_codex', 'daemon', 'codex', 'ready', null, null, 'dh_runner_new', false, null, null],
        ['art_proj_gemini', 'daemon', 'gemini-cli', 'ready', null, null, 'dh_runner_new', false, null, null],
        ['art_proj_pi', 'daemon', 'pi', 'ready', null, null, 'dh_runner_new', false, null, null],
        ['art_projold_codex', 'daemon', 'codex', 'stopped', null, null, 'dh_runner_old', false, null, null],
        ['art_laptop_claude', 'daemon', 'claude-code', 'stopped', 'framework not detected by daemon', null, 'dh_laptop', false, null, null],
        ['art_laptop_codex', 'daemon', 'codex', 'stopped', null, null, 'dh_laptop', false, null, null],
        ['art_revoked_codex', 'daemon', 'codex', 'stopped', null, null, 'dh_revoked', false, null, null],
        ['art_pod_hermes', 'k8s', 'hermes', 'ready', null, 'pdh_adr36', 'dh_podrunner', false, null, null],
        ['art_ext_dify', 'external', 'dify', 'ready', null, null, null, false, null, null]
    ] as const
    for (const [id, kind, framework, status, reason, hostId, daemonId, keepAlive, accountId, spriteName] of runtimes)
        await sql`insert into agent_runtimes (id, user_id, name, framework, kind, status, failure_reason, host_id, daemon_id, keep_alive_enabled, account_id, sprite_name)
            values (${id}, 'usr_adr36', ${id}, ${framework}, ${kind}, ${status}, ${reason}, ${hostId}, ${daemonId}, ${keepAlive}, ${accountId}, ${spriteName})`

    const agents = [
        ['agt_sprite', 'sprites', 'art_sprite_codex', 'running', null, null, 'sbx_adr36'],
        ['agt_laptop', 'daemon', 'art_laptop_codex', 'stopped', 'daemon offline', 'dh_laptop', 'dh_laptop'],
        ['agt_proj', 'daemon', 'art_proj_pi', 'running', null, 'dh_runner_new', null],
        ['agt_ext', 'external', 'art_ext_dify', 'running', null, null, null],
        ['agt_pod', 'k8s', 'art_pod_hermes', 'running', null, 'dh_podrunner', 'pdh_adr36'],
        ['agt_failed', 'daemon', 'art_laptop_claude', 'stopped', 'framework not detected by daemon', 'dh_laptop', 'dh_laptop']
    ] as const
    for (const [id, runtime, runtimeId, status, reason, daemonId, hostId] of agents)
        await sql`insert into agents (id, user_id, name, framework, runtime, runtime_id, status, failure_reason, daemon_id, host_id, internal_id)
            values (${id}, 'usr_adr36', ${id}, 'codex', ${runtime}, ${runtimeId}, ${status}, ${reason}, ${daemonId}, ${hostId}, ${id})`

    await sql`insert into chat_sessions (id, user_id, agent_id) values ('cts_adr36', 'usr_adr36', 'agt_sprite')`
    for (const [id, daemonId] of [['msg_runner', 'dh_runner_new'], ['msg_twin', 'dh_runner_old'], ['msg_laptop', 'dh_laptop'], ['msg_none', null]] as const)
        await sql`insert into chat_messages (id, session_id, role, content_blocks_json, daemon_id, daemon_exec_ref)
            values (${id}, 'cts_adr36', 'assistant', '[]'::jsonb, ${daemonId}, ${daemonId ? 'exec-' + id : null})`
    await sql`insert into terminal_sessions (id, user_id, agent_id, runtime, lease_expires_at, host_id, daemon_id)
        values ('tsn_adr36', 'usr_adr36', 'agt_sprite', 'sprites', now() + interval '1 hour', 'sbx_adr36', 'dh_runner_new')`
}

const rows = async <T extends Record<string, unknown>>(
    sql: Sql,
    query: string
): Promise<T[]> => (await sql.unsafe(query)) as unknown as T[]

const one = async <T extends Record<string, unknown>>(
    sql: Sql,
    query: string
): Promise<T> => {
    const [row] = await rows<T>(sql, query)
    assert.ok(row, `no row for: ${query}`)
    return row
}

test('cutover maps the old runner model onto hosts, host daemons and bound tokens', { skip: !RUN }, async () => {
    const before = journalBefore()
    try {
        await withScratchDatabase(
            'adr36',
            async ({ url }) => {
                const sql = connect(url)
                try {
                    await seedBefore(sql)
                    await apply(url, FOLDER)

                    // providers
                    const providers = await rows<{ id: string; kind: string; name: string; region: string | null; config: Record<string, unknown>; credential_ciphertext: string; priority: number; last_health_status: string }>(sql, 'select * from runtime_providers order by kind')
                    assert.deepEqual(providers.map((p) => [p.id, p.kind, p.name]), [['clus_adr36', 'k8s', 'cluster-adr36'], ['spa_adr36', 'sprites', 'org-adr36']])
                    assert.equal(providers[1].config.orgSlug, 'org')
                    assert.equal(providers[1].credential_ciphertext, 'enc-sprites')
                    assert.equal(providers[1].priority, 3)
                    assert.equal(providers[0].config.hostSuffix, 'suffix.local')
                    assert.equal(providers[0].region, 'eu')
                    assert.equal(providers[0].last_health_status, 'ok')
                    for (const gone of ['sprites_accounts', 'k8s_clusters']) {
                        const [{ present }] = await sql`select to_regclass(${gone})::text as present`
                        assert.equal(present, null, `${gone} should be dropped`)
                    }

                    // hosts: runner rows are gone, kinds and lifecycle are remapped
                    const hosts = await rows<{ id: string; kind: string; status: string; provider_id: string | null; provider_ref: Record<string, unknown> | null; power_state: string | null; keep_awake: boolean }>(sql, 'select * from runtime_hosts order by id')
                    assert.deepEqual(hosts.map((h) => h.id), ['dh_laptop', 'dh_revoked', 'pdh_adr36', 'sbx_adr36'])
                    const byId = new Map(hosts.map((h) => [h.id, h]))
                    const sbx = byId.get('sbx_adr36')!
                    assert.equal(sbx.kind, 'hosted')
                    assert.equal(sbx.status, 'ready')
                    assert.equal(sbx.provider_id, 'spa_adr36')
                    assert.equal(sbx.provider_ref?.spriteName, 'sprite-adr36')
                    assert.equal(sbx.power_state, 'suspended')
                    assert.equal(sbx.keep_awake, true)
                    const laptop = byId.get('dh_laptop')!
                    assert.equal(laptop.kind, 'local')
                    assert.equal(laptop.status, 'ready')
                    assert.equal(laptop.provider_id, null)
                    assert.equal(laptop.keep_awake, false)
                    assert.equal(byId.get('dh_revoked')!.status, 'retired')
                    const pod = byId.get('pdh_adr36')!
                    assert.equal(pod.kind, 'hosted')
                    assert.equal(pod.provider_id, 'clus_adr36')
                    assert.equal(pod.provider_ref?.namespace, 'ns-adr36')
                    assert.equal(pod.provider_ref?.podPhase, 'Running')
                    assert.equal(pod.power_state, 'running')
                    assert.equal(pod.status, 'ready')

                    // one daemon per host; the sandbox keeps the newer twin's connection
                    const daemons = await rows<{ host_id: string; daemon_uuid: string; token_id: string | null; cli_version: string | null }>(sql, 'select * from host_daemons order by host_id')
                    assert.deepEqual(daemons.map((d) => [d.host_id, d.daemon_uuid]), [['dh_laptop', 'uuid-laptop'], ['dh_revoked', 'uuid-revoked'], ['pdh_adr36', 'uuid-pod'], ['sbx_adr36', 'uuid-new']])
                    assert.equal(daemons[3].token_id, 'ldt_runner_new')
                    assert.equal(daemons[3].cli_version, '4.8.0')
                    assert.equal(daemons[0].token_id, 'ldt_laptop')

                    // tokens: bound to hosts, orphans and unbound platform tokens revoked
                    const tokens = await rows<{ id: string; host_id: string | null; revoked_at: string | null }>(sql, 'select id, host_id, revoked_at from daemon_tokens order by id')
                    const token = (id: string) => tokens.find((t) => t.id === id)!
                    assert.equal(token('ldt_laptop').host_id, 'dh_laptop')
                    assert.equal(token('ldt_laptop').revoked_at, null)
                    assert.equal(token('ldt_runner_new').host_id, 'sbx_adr36')
                    assert.equal(token('ldt_runner_old').host_id, 'sbx_adr36')
                    assert.equal(token('ldt_runner_old').revoked_at, null)
                    assert.equal(token('ldt_pod').host_id, 'pdh_adr36')
                    assert.equal(token('ldt_orphan').host_id, null)
                    assert.notEqual(token('ldt_orphan').revoked_at, null)
                    assert.notEqual(token('ldt_unbound_platform').revoked_at, null)
                    assert.equal(token('ldt_unbound_user').host_id, null)
                    assert.equal(token('ldt_unbound_user').revoked_at, null)
                    const tokenColumns = await rows<{ column_name: string }>(sql, "select column_name from information_schema.columns where table_name = 'daemon_tokens'")
                    assert.ok(!tokenColumns.some((c) => c.column_name === 'purpose'))
                    assert.ok(!tokenColumns.some((c) => c.column_name === 'daemon_id'))

                    // runtimes: projections deleted, the one with an agent re-homed, duplicates pruned
                    const runtimes = await rows<{ id: string; host_id: string | null; status: string; failure_reason: string | null }>(sql, 'select id, host_id, status, failure_reason from agent_runtimes order by id')
                    const runtime = (id: string) => runtimes.find((r) => r.id === id)
                    for (const gone of ['art_proj_claude', 'art_proj_codex', 'art_proj_gemini', 'art_projold_codex', 'art_sprite_codex_failed'])
                        assert.equal(runtime(gone), undefined, `${gone} should be deleted`)
                    assert.deepEqual([runtime('art_proj_pi')!.host_id, runtime('art_proj_pi')!.status], ['sbx_adr36', 'ready'])
                    assert.deepEqual([runtime('art_sprite_codex')!.host_id, runtime('art_sprite_codex')!.status], ['sbx_adr36', 'ready'])
                    assert.deepEqual([runtime('art_laptop_claude')!.host_id, runtime('art_laptop_claude')!.status], ['dh_laptop', 'failed'])
                    assert.deepEqual([runtime('art_laptop_codex')!.host_id, runtime('art_laptop_codex')!.status], ['dh_laptop', 'ready'])
                    assert.deepEqual([runtime('art_revoked_codex')!.host_id, runtime('art_revoked_codex')!.status], ['dh_revoked', 'ready'])
                    assert.deepEqual([runtime('art_pod_hermes')!.host_id, runtime('art_pod_hermes')!.status], ['pdh_adr36', 'ready'])
                    assert.deepEqual([runtime('art_ext_dify')!.host_id, runtime('art_ext_dify')!.status], [null, 'ready'])
                    const runtimeColumns = await rows<{ column_name: string }>(sql, "select column_name from information_schema.columns where table_name = 'agent_runtimes'")
                    for (const gone of ['kind', 'daemon_id', 'sprite_name', 'account_id', 'keep_alive_enabled', 'ingress_host'])
                        assert.ok(!runtimeColumns.some((c) => c.column_name === gone), `agent_runtimes.${gone} should be dropped`)

                    // agents: lifecycle only
                    const agents = await rows<{ id: string; status: string }>(sql, 'select id, status from agents order by id')
                    assert.deepEqual(Object.fromEntries(agents.map((a) => [a.id, a.status])), {
                        agt_ext: 'ready',
                        agt_failed: 'failed',
                        agt_laptop: 'ready',
                        agt_pod: 'ready',
                        agt_proj: 'ready',
                        agt_sprite: 'ready'
                    })
                    const agentColumns = await rows<{ column_name: string }>(sql, "select column_name from information_schema.columns where table_name = 'agents'")
                    for (const gone of ['runtime', 'daemon_id', 'host_id', 'sprite_name', 'sprite_status', 'account_id', 'cluster_id', 'namespace', 'ingress_host'])
                        assert.ok(!agentColumns.some((c) => c.column_name === gone), `agents.${gone} should be dropped`)

                    // durable references now name the host
                    const messages = await rows<{ id: string; host_id: string | null }>(sql, 'select id, host_id from chat_messages order by id')
                    assert.deepEqual(Object.fromEntries(messages.map((m) => [m.id, m.host_id])), {
                        msg_laptop: 'dh_laptop',
                        msg_none: null,
                        msg_runner: 'sbx_adr36',
                        msg_twin: 'sbx_adr36'
                    })
                    const terminal = await one<{ host_id: string }>(sql, "select host_id from terminal_sessions where id = 'tsn_adr36'")
                    assert.equal(terminal.host_id, 'sbx_adr36')
                    const terminalColumns = await rows<{ column_name: string }>(sql, "select column_name from information_schema.columns where table_name = 'terminal_sessions'")
                    assert.ok(!terminalColumns.some((c) => c.column_name === 'daemon_id'))

                    // constraints
                    const [{ present }] = await sql`select count(*)::int as present from pg_constraint where conname = 'runtime_hosts_provider_by_kind'`
                    assert.equal(present, 1)
                    const [{ indexes }] = await sql`select count(*)::int as indexes from pg_indexes where indexname = 'agent_runtimes_host_framework_uq'`
                    assert.equal(indexes, 1)

                    // and a second run is a no-op
                    await apply(url, FOLDER)
                    const [{ applied }] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`
                    assert.equal(applied, 28)
                } finally {
                    await sql.end()
                }
            },
            { migrate: (url) => apply(url, before) }
        )
    } finally {
        rmSync(before, { recursive: true, force: true })
    }
})

test('cutover refuses a hosted host without a provider', { skip: !RUN }, async () => {
    const before = journalBefore()
    try {
        await withScratchDatabase(
            'adr36_refuse',
            async ({ url }) => {
                const sql = connect(url)
                try {
                    await sql`insert into plans (id, name, max_agents_provisioned, max_concurrent_active, max_storage_gb) values ('pgtest-adr36r', 'pgtest-adr36r', 5, 5, 10)`
                    await sql`insert into users (id, email, plan_id) values ('usr_adr36r', 'adr36r@pgtest.local', 'pgtest-adr36r')`
                    await sql`insert into runtime_hosts (id, user_id, kind, name, status, sprite_name) values ('sbx_noprov', 'usr_adr36r', 'sandbox', 'sandbox-x', 'active', 'sprite-x')`
                    await assert.rejects(apply(url, FOLDER), /carry no provider/)
                    // the transaction rolled back: the old shape is intact
                    const [{ present }] = await sql`select to_regclass('sprites_accounts')::text as present`
                    assert.equal(present, 'sprites_accounts')
                } finally {
                    await sql.end()
                }
            },
            { migrate: (url) => apply(url, before) }
        )
    } finally {
        rmSync(before, { recursive: true, force: true })
    }
})

test('a fresh install runs the whole journal', { skip: !RUN }, async () => {
    await withScratchDatabase(
        'adr36_fresh',
        async ({ url }) => {
            const sql = connect(url)
            try {
                const [{ applied }] = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`
                assert.equal(applied, 28)
                const [{ present }] = await sql`select to_regclass('host_daemons')::text as present`
                assert.equal(present, 'host_daemons')
            } finally {
                await sql.end()
            }
        },
        { migrate: (url) => apply(url, FOLDER) }
    )
})
