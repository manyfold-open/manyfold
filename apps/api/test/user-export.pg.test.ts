import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import test from 'node:test'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { strFromU8, unzipSync } from 'fflate'
import {
    agentCredentials,
    agentRuntimes,
    agents,
    apiTokens,
    authIdentities,
    automations,
    channels,
    chatMessages,
    chatSessions,
    createDb,
    librarySkillFiles,
    librarySkills,
    sandboxActiveDurationDays,
    skillRepos,
    tokenCredentials,
    userApiUsageDays,
    userConnections,
    userExports,
    userPasswords,
    userSessions,
    userSkills,
    users
} from '@manyfold/db'
import { noopUserLifecyclePort } from '../src/common/ports/user-lifecycle.ports'
import { writeUserExportBundle } from '../src/modules/user-export/export-collectors'
import { ExportTokenService } from '../src/modules/user-export/export-token.service'
import { UserExportStorageService } from '../src/modules/user-export/export-storage.service'
import { UserExportService } from '../src/modules/user-export/user-export.service'
import { runJournal } from '../src/db/migration-runner'

// ADR-0023 §9.2 takeout, proven against real Postgres:
// (1) V-6 secret-free guarantee — a user seeded with every cheaply seedable
//     credential shape (session/api-token hashes, password hash, channel
//     credential ciphertext AND credential-shaped config_json fields, agent
//     extras envText / MCP env / BYO apiKey, connection secret ciphertext,
//     agent credential payload, a leaking port adapter) is exported, and the
//     ENTIRE serialized bundle scans clean: zero hits for the seeded literals
//     and for generic credential shapes. Positive per-domain presence checks
//     make an accidentally-empty export fail too — an empty bundle is
//     trivially secret-free and proves nothing.
// (2) The state machine: queued → (409 while active) → ready with objectKey +
//     ~7d expiresAt + a working emailed download link; a failing collector
//     lands on failed with the step recorded; retention expires the row and
//     deletes the stored object, killing the link.
// (3) V-7 ordering: a grace-period (deactivated) user is exportable through
//     the admin path — their own sessions are revoked, so the self endpoints
//     are unreachable by construction — and a hard-deleted user 404s, with
//     the FK cascade having removed the export rows.
// Env-gated like the other *.pg.test.ts.
const RUN = process.env.RUN_PG_E2E === '1'

const withScratch = async (
    name: string,
    body: (
        client: ReturnType<typeof postgres>,
        dbUrl: string
    ) => Promise<void>
): Promise<void> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const admin = postgres(url, { max: 1, onnotice: () => undefined })
    const dbName = `mf_userexp_${name}_${Date.now().toString(36)}`
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
    const dbUrl = new URL(url)
    dbUrl.pathname = `/${dbName}`
    const client = postgres(dbUrl.toString(), {
        max: 1,
        onnotice: () => undefined
    })
    try {
        await body(client, dbUrl.toString())
    } finally {
        await client.end()
        await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`)
        await admin.end()
    }
}

const applyCore = (client: ReturnType<typeof postgres>) =>
    runJournal(client, {
        folder: join(__dirname, '..', 'drizzle'),
        migrationsTable: '__drizzle_migrations',
        concurrentIndexes: []
    })

interface SentMail {
    to: string
    subject: string
    text?: string
}

// Disk storage keeps the pg suite S3-free: same code path up to the storage
// service, which is the chat-upload fallback pattern rebased on takeout/.
const diskConfig = {
    get: (key: string) =>
        key === 'CHAT_UPLOAD_ALLOW_DISK' ? 'true' : undefined
} as never

const makeService = (
    db: ReturnType<typeof createDb>,
    sent: SentMail[],
    lifecycle = noopUserLifecyclePort
): UserExportService =>
    new UserExportService(
        db as never,
        {
            send: async (mail: SentMail) => {
                sent.push(mail)
            }
        } as never,
        new ExportTokenService(diskConfig),
        new UserExportStorageService(diskConfig),
        diskConfig,
        lifecycle
    )

const endDb = async (db: ReturnType<typeof createDb>): Promise<void> => {
    const raw = (db as unknown as { $client?: { end?: () => Promise<void> } })
        .$client
    if (raw?.end) await raw.end()
}

const tokenFromMail = (mail: SentMail | undefined): string => {
    const match = (mail?.text ?? '').match(/token=([^\s&"']+)/)
    if (!match) throw new Error(`no token in mail: ${mail?.subject}`)
    return decodeURIComponent(match[1])
}

const collectBundle = async (
    db: ReturnType<typeof createDb>,
    userId: string,
    port = noopUserLifecyclePort
): Promise<Record<string, Uint8Array>> => {
    const chunks: Buffer[] = []
    const out = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk))
            callback()
        }
    })
    await writeUserExportBundle({
        db: db as never,
        userId,
        exportId: 'uxp_test',
        port,
        out
    })
    return unzipSync(new Uint8Array(Buffer.concat(chunks)))
}

// Every credential secret the fixture plants, in one list, so the scan and
// the seeding can never drift apart. Each value is unique enough that a hit
// unambiguously names the leak.
const SEEDED_SECRETS = [
    'sk-test-abc123', // agent extras envText, OPENAI_API_KEY
    'sk-ant-seeded456', // agent extras envText, second key
    'sk-byo-seeded-789', // agent extras modelConfig.apiKey
    'ldt_seededmcpsecret', // agent extras MCP server env
    'pat_seededbearer', // agent extras MCP server auth header
    'SEEDEDCHANNELCIPHER', // channels.credentials_ciphertext
    'seeded-verification-token', // channels.config_json (Lark keeps it there)
    'seeded-encrypt-key', // channels.config_json
    'SEEDEDCLOUDFLARECIPHER', // user_connections.secret_ciphertext
    'SEEDEDAGENTCREDCIPHER', // agent_credentials.payload_ciphertext
    'seeded-password-hash-material', // user_passwords.password_hash
    'hash-of-mfs_seededsessiontoken', // user_sessions.token_hash
    'hash-of-pat_seededapitoken', // api_tokens.token_hash
    'sk-live-cloud-seeded' // a LEAKING port adapter's output
]

const seedFixtureUser = async (db: ReturnType<typeof createDb>) => {
    await db.insert(users).values({
        id: 'usr_v6',
        email: 'v6@pgtest.local',
        displayName: 'V Six',
        planId: 'free'
    })
    await db.insert(userPasswords).values({
        userId: 'usr_v6',
        passwordHash: 'argon2id$seeded-password-hash-material'
    })
    await db.insert(userSessions).values({
        id: 'ses_v6',
        userId: 'usr_v6',
        tokenHash: 'hash-of-mfs_seededsessiontoken',
        provider: 'email',
        subject: 'v6',
        expiresAt: new Date(Date.now() + 86_400_000)
    })
    await db.insert(tokenCredentials).values({
        tokenHash: 'hash-of-pat_seededapitoken',
        kind: 'external'
    })
    await db.insert(apiTokens).values({
        id: 'tok_v6',
        userId: 'usr_v6',
        name: 'ci token',
        tokenHash: 'hash-of-pat_seededapitoken',
        scopes: ['api.full']
    })
    await db.insert(agentRuntimes).values({
        id: 'art_v6',
        userId: 'usr_v6',
        name: 'main-runtime',
        framework: 'claude-code',
        kind: 'daemon'
    })
    await db.insert(agentCredentials).values({
        id: 'acr_v6',
        runtimeId: 'art_v6',
        framework: 'claude-code',
        payloadCiphertext: 'enc:v1:SEEDEDAGENTCREDCIPHER'
    })
    await db.insert(agents).values({
        id: 'agt_v6',
        userId: 'usr_v6',
        name: 'main-agent',
        framework: 'claude-code',
        runtime: 'daemon',
        runtimeId: 'art_v6',
        internalId: 'ia_v6',
        extras: {
            a2aExposure: 'public',
            envText:
                'OPENAI_API_KEY=sk-test-abc123\nANTHROPIC_API_KEY=sk-ant-seeded456',
            modelConfig: { provider: 'byo', apiKey: 'sk-byo-seeded-789' },
            mcp: {
                servers: {
                    docs: {
                        command: 'npx',
                        args: ['docs-mcp'],
                        env: { MCP_TOKEN: 'ldt_seededmcpsecret' },
                        headers: { authorization: 'Bearer pat_seededbearer' }
                    }
                }
            }
        }
    })
    await db.insert(channels).values({
        id: 'chn_v6',
        userId: 'usr_v6',
        agentId: 'agt_v6',
        provider: 'lark',
        label: 'lark main',
        configJson: {
            appId: 'cli_a1b2',
            subscriptionMode: 'websocket',
            verificationToken: 'seeded-verification-token',
            encryptKey: 'seeded-encrypt-key',
            mentionOnly: false
        },
        credentialsCiphertext: 'enc:v1:SEEDEDCHANNELCIPHER'
    })
    await db.insert(automations).values({
        id: 'aut_v6',
        userId: 'usr_v6',
        agentId: 'agt_v6',
        title: 'daily digest',
        prompt: 'summarise the day',
        schedulePreset: 'daily',
        rrule: 'FREQ=DAILY',
        timezone: 'UTC',
        dtstart: new Date('2026-08-01T08:00:00Z')
    })
    await db.insert(chatSessions).values({
        id: 'cts_v6',
        userId: 'usr_v6',
        agentId: 'agt_v6',
        title: 'first chat'
    })
    await db.insert(chatMessages).values([
        {
            id: 'msg_v6a',
            sessionId: 'cts_v6',
            role: 'user',
            contentBlocksJson: [{ type: 'text', text: 'hello world' }]
        },
        {
            id: 'msg_v6b',
            sessionId: 'cts_v6',
            role: 'assistant',
            contentBlocksJson: [{ type: 'text', text: 'hi! all done.' }]
        }
    ])
    await db.insert(librarySkills).values({
        id: 'skl_v6',
        userId: 'usr_v6',
        name: 'my-skill',
        content: 'Do the thing carefully.',
        contentHash: 'deadbeef'
    })
    await db.insert(librarySkillFiles).values({
        id: 'skf_v6',
        librarySkillId: 'skl_v6',
        path: 'references/notes.md',
        content: 'extra notes'
    })
    await db.insert(userSkills).values({
        id: 'usk_v6',
        userId: 'usr_v6',
        librarySkillId: 'skl_v6',
        agentId: 'agt_v6',
        framework: 'claude-code',
        installDir: 'my-skill'
    })
    await db.insert(skillRepos).values({
        id: 'skr_v6',
        userId: 'usr_v6',
        owner: 'acme',
        name: 'skills'
    })
    await db.insert(userApiUsageDays).values({
        userId: 'usr_v6',
        day: '2026-08-01',
        requestCount: 5
    })
    await db.insert(sandboxActiveDurationDays).values({
        hostId: 'host_v6',
        userId: 'usr_v6',
        day: '2026-08-01',
        activeSeconds: 1200
    })
    await db.insert(userConnections).values({
        id: 'ucn_v6',
        userId: 'usr_v6',
        provider: 'cloudflare',
        kind: 'cloudflare_api_token',
        displayName: 'CF account',
        externalId: 'acc-123',
        secretCiphertext: 'enc:v1:SEEDEDCLOUDFLARECIPHER',
        metadata: { accountName: 'acme' }
    })
    await db.insert(authIdentities).values({
        provider: 'google',
        subject: 'goog-sub-1',
        userId: 'usr_v6',
        email: 'v6@pgtest.local'
    })
}

test(
    'V-6: the full bundle of a credential-laden user scans secret-free — and is NOT empty',
    { skip: !RUN },
    async () => {
        await withScratch('v6', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await seedFixtureUser(db)
                // A port adapter that leaks a key alongside legitimate
                // billing data: the pipeline must redact it — the guarantee
                // cannot rest on adapters behaving.
                const leakyPort = {
                    ...noopUserLifecyclePort,
                    collectUserExport: async () => ({
                        billing: {
                            invoices: [{ number: 'INV-001', total: 1200 }],
                            stripeApiKey: 'sk-live-cloud-seeded'
                        }
                    })
                }
                const zip = await collectBundle(db, 'usr_v6', leakyPort)
                const text = Object.entries(zip)
                    .map(
                        ([name, bytes]) => `${name}\n${strFromU8(bytes)}`
                    )
                    .join('\n')

                // Zero hits for every seeded secret, by literal…
                for (const secret of SEEDED_SECRETS)
                    assert.ok(
                        !text.includes(secret),
                        `seeded secret leaked into the bundle: ${secret}`
                    )
                // …and by shape, so a leak of a NON-seeded credential column
                // (or a future collector skipping redaction) is caught too.
                for (const shape of [
                    /sk-[A-Za-z0-9]/,
                    /\bmfs_[A-Za-z0-9]/,
                    /\bldt_[A-Za-z0-9]/,
                    /\bpat_[A-Za-z0-9]/
                ])
                    assert.ok(
                        !shape.test(text),
                        `credential-shaped value leaked: ${shape}`
                    )

                // The scan is only meaningful if the export actually carries
                // the user's data — an empty bundle is secret-free too.
                const profile = JSON.parse(strFromU8(zip['profile.json']))
                assert.equal(profile.email, 'v6@pgtest.local')
                const agentsText = strFromU8(zip['agents.ndjson'])
                assert.ok(agentsText.includes('main-agent'))
                assert.ok(agentsText.includes('"a2aExposure":"public"'))
                assert.ok(
                    agentsText.includes('[redacted]'),
                    'redaction markers must show where config was withheld'
                )
                assert.ok(
                    strFromU8(zip['agent-runtimes.ndjson']).includes(
                        'main-runtime'
                    )
                )
                const channelsText = strFromU8(zip['channels.ndjson'])
                assert.ok(channelsText.includes('lark main'))
                assert.ok(channelsText.includes('cli_a1b2'))
                assert.ok(channelsText.includes('[redacted]'))
                assert.ok(
                    strFromU8(zip['chat-messages/cts_v6.ndjson']).includes(
                        'hello world'
                    )
                )
                assert.ok(
                    strFromU8(zip['library-skills.ndjson']).includes(
                        'Do the thing carefully.'
                    )
                )
                assert.ok(
                    strFromU8(zip['skill-installs.ndjson']).includes('skl_v6')
                )
                assert.ok(
                    strFromU8(zip['usage-api-days.ndjson']).includes(
                        '2026-08-01'
                    )
                )
                assert.ok(
                    strFromU8(zip['connections.ndjson']).includes('acc-123')
                )
                assert.ok(
                    strFromU8(zip['identities.ndjson']).includes('goog-sub-1')
                )
                const billing = JSON.parse(strFromU8(zip['billing.json']))
                assert.equal(billing.invoices[0].number, 'INV-001')
                assert.equal(billing.stripeApiKey, '[redacted]')
                const manifest = JSON.parse(strFromU8(zip['manifest.json']))
                assert.equal(manifest.format, 'manyfold-takeout/1')
                assert.ok(manifest.entries.includes('profile.json'))
                assert.ok(
                    manifest.entries.includes('automations.ndjson'),
                    'every domain shows up in the manifest'
                )
            } finally {
                await endDb(db)
            }
        })
    }
)

test(
    'state machine: queued (409 while active) → ready with a working emailed link → retention expires the object and the link',
    { skip: !RUN },
    async () => {
        await withScratch('flow', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await db.insert(users).values({
                    id: 'usr_flow',
                    email: 'flow@pgtest.local',
                    planId: 'free'
                })
                const sent: SentMail[] = []
                const service = makeService(db, sent)

                const queued = await service.request({
                    userId: 'usr_flow',
                    requestedBy: 'usr_flow'
                })
                assert.equal(queued.status, 'queued')
                assert.equal(queued.downloadUrl, null)
                // One active export per user.
                await assert.rejects(
                    service.request({
                        userId: 'usr_flow',
                        requestedBy: 'usr_flow'
                    }),
                    /already in progress/
                )

                await service.sweep()
                const ready = await service.status('usr_flow')
                assert.equal(ready?.status, 'ready')
                assert.ok(ready?.downloadUrl?.includes('/me/export/download'))
                assert.ok(ready?.expiresAt, 'retention deadline must be set')
                const days =
                    (ready!.expiresAt!.getTime() - Date.now()) / 86_400_000
                assert.ok(days > 6.9 && days <= 7.01, `~7d retention, got ${days}`)

                // The EMAILED link is the one that must work (it may be the
                // user's only path — see V-7): pull the token back out of the
                // rendered mail and download with it.
                assert.equal(sent.length, 1)
                assert.equal(sent[0].to, 'flow@pgtest.local')
                const token = tokenFromMail(sent[0])
                const { stream, filename } = await service.download(token)
                const chunks: Buffer[] = []
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk))
                const zip = unzipSync(new Uint8Array(Buffer.concat(chunks)))
                assert.ok(zip['profile.json'], 'the download is a real bundle')
                assert.match(filename, /^manyfold-export-.*\.zip$/)

                // A fresh request after ready is allowed (it is a new
                // export), so "ready" must not 409.
                // …but first: retention. Past expiresAt the sweep deletes the
                // object and the row flips to expired — the emailed link and
                // the status link die with it (bucket lifecycle rules are
                // not assumed; the sweep IS the retention mechanism).
                const [row] = await db
                    .select()
                    .from(userExports)
                    .where(eq(userExports.userId, 'usr_flow'))
                const objectKey = row.objectKey!
                await db
                    .update(userExports)
                    .set({ expiresAt: new Date(Date.now() - 1000) })
                    .where(eq(userExports.id, row.id))
                await service.sweep()
                const expired = await service.status('usr_flow')
                assert.equal(expired?.status, 'expired')
                assert.equal(expired?.downloadUrl, null)
                await assert.rejects(service.download(token), /not found/)
                await assert.rejects(
                    stat(join(tmpdir(), 'manyfold-takeout', objectKey)),
                    'the stored object must be deleted at expiry'
                )

                const again = await service.request({
                    userId: 'usr_flow',
                    requestedBy: 'usr_flow'
                })
                assert.equal(again.status, 'queued')
            } finally {
                await rm(
                    join(tmpdir(), 'manyfold-takeout', 'takeout', 'usr_flow'),
                    { recursive: true, force: true }
                )
                await endDb(db)
            }
        })
    }
)

test(
    'a failing collector lands on failed with the step recorded; re-request is the retry path',
    { skip: !RUN },
    async () => {
        await withScratch('fail', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                await db.insert(users).values({
                    id: 'usr_fail',
                    email: 'fail@pgtest.local',
                    planId: 'free'
                })
                const sent: SentMail[] = []
                const service = makeService(db, sent, {
                    ...noopUserLifecyclePort,
                    collectUserExport: async () => {
                        throw new Error('cloud collector down')
                    }
                })
                await service.request({
                    userId: 'usr_fail',
                    requestedBy: 'usr_fail'
                })
                await service.sweep()
                const failed = await service.status('usr_fail')
                assert.equal(failed?.status, 'failed')
                assert.equal(failed?.lastError?.step, 'collect')
                assert.match(failed!.lastError!.message, /cloud collector down/)
                assert.equal(sent.length, 0, 'no ready email for a failure')
                // failed is terminal, not active: the user may retry.
                const retry = await service.request({
                    userId: 'usr_fail',
                    requestedBy: 'usr_fail'
                })
                assert.equal(retry.status, 'queued')
            } finally {
                await endDb(db)
            }
        })
    }
)

test(
    'V-7: a grace-period user exports through the admin path; a hard-deleted user 404s and cascade removed the rows',
    { skip: !RUN },
    async () => {
        await withScratch('order', async (client, dbUrl) => {
            await applyCore(client)
            const db = createDb(dbUrl, { max: 1 })
            try {
                // Post-T0 shape: flag set, sessions revoked. The /me/export
                // endpoints are unreachable for this user by construction
                // (no session survives T0 — proven in user-deletion V-2);
                // the admin trigger is exactly for them.
                await db.insert(users).values({
                    id: 'usr_grace',
                    email: 'grace@pgtest.local',
                    planId: 'free',
                    deactivatedAt: new Date()
                })
                const sent: SentMail[] = []
                const service = makeService(db, sent)
                const status = await service.request({
                    userId: 'usr_grace',
                    requestedBy: 'admin_1'
                })
                assert.equal(status.status, 'queued')
                await service.sweep()
                assert.equal(
                    (await service.status('usr_grace'))?.status,
                    'ready'
                )
                // The ready email goes to the account mailbox — post-T0 the
                // mailbox is the only channel the user still has.
                assert.equal(sent[0]?.to, 'grace@pgtest.local')

                // Hard-deleted user: nothing left to export.
                await db.delete(users).where(eq(users.id, 'usr_grace'))
                await assert.rejects(
                    service.request({
                        userId: 'usr_grace',
                        requestedBy: 'admin_1'
                    }),
                    /not found/
                )
                // …and the FK cascade took the export bookkeeping with it.
                const rows = await db
                    .select()
                    .from(userExports)
                    .where(eq(userExports.userId, 'usr_grace'))
                assert.equal(rows.length, 0)
            } finally {
                await rm(
                    join(tmpdir(), 'manyfold-takeout', 'takeout', 'usr_grace'),
                    { recursive: true, force: true }
                )
                await endDb(db)
            }
        })
    }
)
