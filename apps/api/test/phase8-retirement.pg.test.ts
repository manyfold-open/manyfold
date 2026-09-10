import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import postgres from 'postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/postgres-js'
import { ConfigService } from '@nestjs/config'
import { agents, agentRuntimes, apiTokens, schema, users } from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import {
    ApiTokenService,
    hashApiToken
} from '../src/modules/auth/api-token.service'
import { RuntimeTokenService } from '../src/modules/auth/runtime-token.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { CliAuthService } from '../src/modules/auth/cli-auth.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'

const RUN = process.env.RUN_PG_E2E === '1'
const retirement = readFileSync(
    'drizzle/0010_phase8_user_grant_retirement.sql',
    'utf8'
)
const bindingSwitch = readFileSync(
    'drizzle/0011_phase8_a2a_binding_switch.sql',
    'utf8'
)
const contract = readFileSync(
    'drizzle/0012_phase8_user_grant_columns.contract.sql',
    'utf8'
)

test(
    'contract upgrades the switched schema without changing A2A or browser credentials',
    { skip: !RUN },
    async () => {
        await withScratchDatabase(
            'phase8_contract',
            async ({ url }) => {
                const sql = postgres(url, { max: 1, onnotice: () => {} })
                const db = drizzle(sql, { schema })
                try {
                    const journal = JSON.parse(
                        readFileSync('drizzle/meta/_journal.json', 'utf8')
                    )
                    const boundary = journal.entries.find(
                        (entry: { tag: string }) =>
                            entry.tag ===
                            '0012_phase8_user_grant_columns.contract'
                    ).when as number
                    for (const migration of readMigrationFiles({
                        migrationsFolder: 'drizzle'
                    })) {
                        if (migration.folderMillis >= boundary) break
                        for (const statement of migration.sql)
                            await sql.unsafe(statement)
                    }
                    const userId = 'usr_phase8_contract'
                    await db
                        .insert(users)
                        .values({ id: userId, email: 'contract@example.test' })
                    await db.insert(agentRuntimes).values({
                        id: 'art_contract',
                        userId,
                        name: 'contract',
                        kind: 'sprites',
                        framework: 'codex'
                    })
                    await db.insert(agents).values({
                        id: 'agt_contract',
                        userId,
                        runtimeId: 'art_contract',
                        internalId: 'default',
                        name: 'contract',
                        runtime: 'sprites',
                        framework: 'codex'
                    })
                    const tokens = new ApiTokenService(db)
                    const external = await tokens.mintA2aGrant({
                        userId,
                        targetAgentId: 'agt_contract'
                    })
                    const pat = await tokens.mint({ userId, name: 'personal' })
                    const cli = new CliAuthService(
                        db,
                        new ConfigService(),
                        tokens,
                        new CliAuthRateLimitService()
                    )
                    const browser = await cli.start({})
                    await db.insert(apiTokens).values({
                        id: 'pat_old_contract',
                        userId,
                        agentId: 'agt_contract',
                        name: 'old',
                        scopes: ['agents:read'],
                        tokenKind: 'user-grant',
                        tokenHash: hashApiToken('nca_old_contract')
                    })
                    await assert.rejects(
                        sql.unsafe(contract),
                        /all agent user-grants/
                    )
                    await tokens.revoke({ userId, tokenId: 'pat_old_contract' })
                    await sql.unsafe(
                        "insert into api_tokens(id,user_id,name,scopes,token_kind,token_hash) values ($1,$2,'retired ephemeral','[]','a2a-ephemeral',$3)",
                        [
                            'pat_retired_ephemeral',
                            userId,
                            hashApiToken('nca_retired_ephemeral')
                        ]
                    )
                    await sql.unsafe(contract)
                    await sql.unsafe(contract)
                    const [{ remaining }] = await sql`
                select count(*)::int as remaining from information_schema.columns
                where (table_name='api_tokens' and column_name='enforce_agent_binding')
                   or (table_name='cli_auth_sessions' and column_name in (
                       'requested_scopes','approved_scopes','requested_agent_id','device_code_hash','polled_at'
                   ))
            `
                    assert.equal(remaining, 0)
                    assert.equal(
                        (await tokens.verify(external.plaintext)).kind,
                        'legacy-runtime'
                    )
                    assert.equal(
                        await tokens.isActiveExternalA2aGrant(
                            external.tokenId,
                            'agt_contract'
                        ),
                        true
                    )
                    assert.equal(
                        (await tokens.verify(pat.plaintext)).kind,
                        'human-api-token'
                    )
                    const approved = await cli.approve({
                        requestId: browser.requestId,
                        userCode: browser.userCode,
                        userId
                    })
                    assert.ok((await cli.exchange(approved.authCode)).token)
                    assert.equal(
                        (
                            await sql`select id from api_tokens where token_kind='a2a-ephemeral'`
                        ).length,
                        0
                    )
                    assert.equal(
                        (
                            await sql`select token_hash from token_credentials where token_hash=${hashApiToken('nca_retired_ephemeral')}`
                        ).length,
                        0
                    )
                    const [indexes] = await sql`
                select to_regclass('api_tokens_agent_id_active_uq')::text as retired,
                    to_regclass('api_tokens_a2a_grant_uq')::text as retained
            `
                    assert.equal(indexes.retired, null)
                    assert.equal(indexes.retained, 'api_tokens_a2a_grant_uq')
                    const [compatibility] = await sql`
                        select to_regprocedure('public.phase8_guard_legacy_binding()')::text as binding_function,
                            (select count(*)::int from pg_trigger where tgname='phase8_guard_legacy_binding' and not tgisinternal) as binding_triggers
                    `
                    assert.equal(compatibility.binding_function, null)
                    assert.equal(compatibility.binding_triggers, 0)
                } finally {
                    await sql.end()
                }
            },
            { migrate: async () => {} }
        )
    }
)

test(
    'A2A switch preparation binds existing and newly minted grants for old API readers',
    { skip: !RUN },
    async () => {
        await withScratchDatabase(
            'phase8_binding',
            async ({ url }) => {
                const sql = postgres(url, { max: 1, onnotice: () => {} })
                const db = drizzle(sql, { schema })
                try {
                    const journal = JSON.parse(
                        readFileSync('drizzle/meta/_journal.json', 'utf8')
                    )
                    const boundary = journal.entries.find(
                        (entry: { tag: string }) =>
                            entry.tag === '0011_phase8_a2a_binding_switch'
                    ).when as number
                    for (const migration of readMigrationFiles({
                        migrationsFolder: 'drizzle'
                    })) {
                        if (migration.folderMillis >= boundary) break
                        for (const statement of migration.sql)
                            await sql.unsafe(statement)
                    }
                    const userId = 'usr_binding_switch'
                    const agentId = 'agt_binding_switch'
                    await db
                        .insert(users)
                        .values({ id: userId, email: 'binding@example.test' })
                    await db.insert(agentRuntimes).values({
                        id: 'art_binding_switch',
                        userId,
                        name: 'binding',
                        kind: 'sprites',
                        framework: 'codex'
                    })
                    await db.insert(agents).values({
                        id: agentId,
                        userId,
                        runtimeId: 'art_binding_switch',
                        internalId: 'default',
                        name: 'binding',
                        runtime: 'sprites',
                        framework: 'codex'
                    })
                    const tokens = new ApiTokenService(db)
                    const existing = await tokens.mintA2aGrant({
                        userId,
                        targetAgentId: agentId
                    })
                    await sql`update api_tokens set enforce_agent_binding=false where id=${existing.tokenId}`
                    await sql.begin((tx) => tx.unsafe(bindingSwitch))
                    const fresh = await tokens.mintA2aGrant({
                        userId,
                        targetAgentId: agentId
                    })
                    for (const tokenId of [existing.tokenId, fresh.tokenId]) {
                        const [row] =
                            await sql`select enforce_agent_binding from api_tokens where id=${tokenId}`
                        assert.equal(row.enforce_agent_binding, true)
                    }
                    await sql.begin((tx) => tx.unsafe(bindingSwitch))
                    assert.equal(
                        (await tokens.verify(fresh.plaintext)).kind,
                        'legacy-runtime'
                    )
                    const pat = await tokens.mint({ userId, name: 'personal' })
                    const [patBinding] =
                        await sql`select enforce_agent_binding from api_tokens where id=${pat.tokenId}`
                    assert.equal(patBinding.enforce_agent_binding, false)
                    assert.equal(
                        (await tokens.verify(pat.plaintext)).kind,
                        'human-api-token'
                    )
                    await sql`drop trigger phase8_guard_legacy_binding on api_tokens`
                    await sql`drop function public.phase8_guard_legacy_binding()`
                    await sql`alter table api_tokens drop column enforce_agent_binding`
                    await sql.begin((tx) => tx.unsafe(bindingSwitch))
                } finally {
                    await sql.end()
                }
            },
            { migrate: async () => {} }
        )
    }
)

test(
    'Phase 8 preflight blocks live compatibility data and preserves rolling-deploy columns',
    { skip: !RUN },
    async () => {
        await withScratchDatabase(
            'phase8_preflight',
            async ({ url }) => {
                const sql = postgres(url, { max: 1 })
                try {
                    await sql.unsafe(`
                create table api_tokens (agent_id text, token_kind text, revoked_at timestamptz,
                    expires_at timestamptz, enforce_agent_binding boolean);
                create table agent_runtime_tokens (revoked_at timestamptz, token_ciphertext text, token_key_version integer);
                create table cli_auth_sessions (id text, requested_scopes jsonb, expires_at timestamptz);
                insert into api_tokens values ('agt_A', 'user-grant', null, null, false);
            `)
                    await assert.rejects(
                        sql.unsafe(retirement),
                        /revoking active agent user-grant/
                    )
                    await sql.unsafe(
                        'delete from api_tokens; insert into agent_runtime_tokens values (null, null, null)'
                    )
                    await assert.rejects(
                        sql.unsafe(retirement),
                        /encrypted copies/
                    )
                    await sql.unsafe(
                        "update agent_runtime_tokens set token_ciphertext='encrypted', token_key_version=1"
                    )
                    await sql.unsafe(
                        "insert into cli_auth_sessions values ('grant', '[]', now() + interval '1 minute')"
                    )
                    await assert.rejects(
                        sql.unsafe(retirement),
                        /CLI grant sessions to expire/
                    )
                    await sql.unsafe(
                        "update cli_auth_sessions set expires_at=now() - interval '1 minute'"
                    )
                    await sql.unsafe(
                        "insert into cli_auth_sessions values ('browser', null, now() + interval '1 minute')"
                    )
                    await sql.unsafe(retirement)
                    await sql.unsafe(retirement)
                    assert.deepEqual(
                        Array.from(await sql`select id from cli_auth_sessions`),
                        [{ id: 'browser' }]
                    )
                    const columns = await sql`
                select column_name from information_schema.columns
                where table_name='api_tokens' and column_name='enforce_agent_binding'
            `
                    assert.equal(columns.length, 1)
                } finally {
                    await sql.end()
                }
            },
            { migrate: async () => {} }
        )
    }
)

test(
    'migrated auth keeps browser/runtime/A2A behavior and rejects retired user grants',
    { skip: !RUN },
    async () => {
        await withScratchDatabase('phase8_auth', async ({ url }) => {
            const sql = postgres(url, { max: 1 })
            const db = drizzle(sql, { schema })
            try {
                const userId = 'usr_phase8_test'
                const runtimeId = 'art_phase8_test'
                await db
                    .insert(users)
                    .values({ id: userId, email: 'phase8@example.test' })
                await db.insert(agentRuntimes).values({
                    id: runtimeId,
                    userId,
                    name: 'Phase 8',
                    framework: 'codex',
                    kind: 'sprites'
                })
                for (const id of ['agt_A', 'agt_B'])
                    await db.insert(agents).values({
                        id,
                        userId,
                        runtimeId,
                        internalId: id,
                        name: id,
                        framework: 'codex',
                        runtime: 'sprites'
                    })
                const tokens = new ApiTokenService(db)
                const config = new ConfigService({
                    API_CRYPTO_KEY: Buffer.alloc(32, 7).toString('base64'),
                    MF_WEB_URL: 'https://example.test'
                })
                const runtime = await new RuntimeTokenService(
                    db,
                    new CryptoService(config)
                ).mintRuntimeIdentity({
                    userId,
                    agentId: 'agt_A',
                    runtimeKind: 'sprites'
                })
                assert.equal(
                    (await tokens.verify(runtime.plaintext)).kind,
                    'agent-runtime'
                )
                const grant = await tokens.mintA2aGrant({
                    userId,
                    targetAgentId: 'agt_A'
                })
                assert.equal(
                    (await tokens.verify(grant.plaintext)).kind,
                    'legacy-runtime'
                )
                assert.equal(
                    await tokens.isActiveExternalA2aGrant(
                        grant.tokenId,
                        'agt_A'
                    ),
                    true
                )
                assert.equal(
                    await tokens.isActiveExternalA2aGrant(
                        grant.tokenId,
                        'agt_B'
                    ),
                    false
                )
                await tokens.revokeA2aGrant({
                    tokenId: grant.tokenId,
                    userId,
                    targetAgentId: 'agt_A'
                })
                await assert.rejects(tokens.verify(grant.plaintext), /revoked/)
                assert.equal(
                    await tokens.isActiveExternalA2aGrant(
                        grant.tokenId,
                        'agt_A'
                    ),
                    false
                )
                await db.insert(apiTokens).values({
                    id: 'pat_old',
                    userId,
                    agentId: 'agt_A',
                    name: 'old grant',
                    tokenHash: hashApiToken('nca_old_grant'),
                    tokenKind: 'user-grant',
                    scopes: ['agents:edit']
                })
                await assert.rejects(
                    tokens.verify('nca_old_grant'),
                    /agent bearer grants are retired/
                )
                const cli = new CliAuthService(
                    db,
                    config,
                    tokens,
                    new CliAuthRateLimitService()
                )
                const start = await cli.start({})
                const approved = await cli.approve({
                    requestId: start.requestId,
                    userCode: start.userCode,
                    userId
                })
                const exchanged = await cli.exchange(approved.authCode)
                assert.equal(
                    (await tokens.verify(exchanged.token)).kind,
                    'human-api-token'
                )
                await assert.rejects(
                    cli.exchange(approved.authCode),
                    /already used/
                )
            } finally {
                await sql.end()
            }
        })
    }
)
