import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import {
    createDb,
    users,
    agentRuntimes,
    agents,
    agentBackups,
    agentBackupRestores,
    serviceLeases,
    spritesAccounts,
    runtimeHosts,
    type Agent
} from '@manyfold/db'
import { ConflictException } from '@nestjs/common'
import { ServiceLeaseService } from '../src/common/leases/service-lease.service'
import { BackupOperationsService } from '../src/modules/backups/backup-operations.service'
import { BackupsService } from '../src/modules/backups/backups.service'
import {
    WorkspaceRuntimeService,
    workspaceOperationKey
} from '../src/modules/backups/workspace-runtime.service'
import { workspaceOperationRoot } from '../src/modules/backups/workspace-operation-scripts'

const RUN = process.env.RUN_PG_E2E === '1'
const exec = promisify(execFile)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test(
    'the rollout constraint waits for legacy work and rejects old-code admission',
    { skip: !RUN },
    async () => {
        const db = createDb(process.env.DATABASE_URL!)
        const migration = await readFile(
            join(__dirname, '../drizzle/0018_require_owned_backup_jobs.sql'),
            'utf8'
        )
        try {
            await db.$client.begin(async (tx) => {
                await tx.unsafe(
                    'create temporary table agent_backups (like public.agent_backups including defaults) on commit drop'
                )
                await tx.unsafe(
                    'create temporary table agent_backup_restores (like public.agent_backup_restores including defaults) on commit drop'
                )
                await tx.unsafe(
                    "insert into agent_backups (id, user_id, source_agent_name, framework, runtime_kind, object_key) values ('legacy', 'test', 'test', 'codex', 'daemon', 'legacy')"
                )
                await assert.rejects(
                    tx.savepoint((sp) => sp.unsafe(migration)),
                    (error) => (error as { code?: string }).code === '23514'
                )
                await tx.unsafe(
                    "update agent_backups set status = 'succeeded' where id = 'legacy'"
                )
                await tx.unsafe(migration)
                await assert.rejects(
                    tx.savepoint((sp) =>
                        sp.unsafe(
                            "insert into agent_backups (id, user_id, source_agent_name, framework, runtime_kind, object_key) values ('old-api', 'test', 'test', 'codex', 'daemon', 'old-api')"
                        )
                    ),
                    (error) => (error as { code?: string }).code === '23514'
                )
                await assert.rejects(
                    tx.savepoint((sp) =>
                        sp.unsafe(
                            "insert into agent_backup_restores (id, user_id, backup_id) values ('old-restore', 'test', 'legacy')"
                        )
                    ),
                    (error) => (error as { code?: string }).code === '23514'
                )
            })
        } finally {
            await db.$client.end()
        }
    }
)

test(
    'backup admission, peer startup, expiry recovery and restore preserve workspace state',
    { skip: !RUN },
    async () => {
        const db = createDb(process.env.DATABASE_URL!, { max: 5 })
        const peerDb = createDb(process.env.DATABASE_URL!, { max: 5 })
        const suffix = randomUUID()
        const userId = `user_backup_${suffix}`
        const accountId = `spa_${suffix}`
        const daemonId = `rth_${suffix}`
        const dir = await mkdtemp(join(tmpdir(), 'mf-backup-pg-'))
        const workspace = join(dir, 'workspace')
        await mkdir(workspace)
        const keys: string[] = []
        const createdServices: BackupsService[] = []
        let releaseUpload: (() => void) | undefined
        let held = false
        let failUpload = false
        const objects = new Map<string, Buffer>()
        const storage = {
            assertConfigured() {},
            retentionCount: () => 20,
            objectKey: ({ backupId }: { backupId: string }) => backupId,
            upload: async (key: string, stream: AsyncIterable<Uint8Array>) => {
                if (held)
                    await new Promise<void>((resolve) => {
                        releaseUpload = resolve
                    })
                if (failUpload) throw new Error('synthetic upload failure')
                const chunks: Buffer[] = []
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk))
                const body = Buffer.concat(chunks)
                objects.set(key, body)
                return {
                    bytes: body.length,
                    sha256: createHash('sha256').update(body).digest('hex')
                }
            },
            download: async (key: string) => ({
                stream: Readable.from([objects.get(key)!]),
                size: objects.get(key)!.length
            }),
            deleteObject: async (key: string) => {
                objects.delete(key)
            }
        }
        const runtime = Object.create(
            WorkspaceRuntimeService.prototype
        ) as WorkspaceRuntimeService
        Object.assign(runtime, {
            run: async (_agent: Agent, script: string) =>
                exec('bash', ['-c', script], { timeout: 15000 }),
            readFile: async (_agent: Agent, path: string) => ({
                stream: Readable.from([await readFile(path)])
            }),
            writeFile: async (
                _agent: Agent,
                path: string,
                stream: AsyncIterable<Uint8Array>
            ) => {
                await mkdir(join(workspace, '.nca-backup-tmp'), {
                    recursive: true
                })
                const chunks: Buffer[] = []
                for await (const chunk of stream)
                    chunks.push(Buffer.from(chunk))
                await writeFile(path, Buffer.concat(chunks))
            },
            log: { warn() {} }
        })
        const operations = new BackupOperationsService(
            db,
            new ServiceLeaseService(db)
        )
        const peerOperations = new BackupOperationsService(
            peerDb,
            new ServiceLeaseService(peerDb)
        )
        const first = new BackupsService(
            db,
            storage as never,
            runtime,
            operations
        )
        const peer = new BackupsService(
            peerDb,
            storage as never,
            runtime,
            peerOperations
        )
        createdServices.push(first, peer)
        const settle = async (id: string, restore = false) => {
            const table = restore ? agentBackupRestores : agentBackups
            for (let n = 0; n < 200; n++) {
                const [row] = await db
                    .select()
                    .from(table)
                    .where(eq(table.id, id))
                if (row.status !== 'running') {
                    const active = await db
                        .select()
                        .from(serviceLeases)
                        .where(eq(serviceLeases.holderId, id))
                    if (active.length === 0) return row
                }
                await delay(20)
            }
            throw new Error(`job ${id} did not settle`)
        }
        try {
            await db
                .insert(users)
                .values({ id: userId, email: `${suffix}@pgtest.local` })
            await db.insert(spritesAccounts).values({
                id: accountId,
                slug: suffix,
                orgSlug: 'test',
                orgId: 'test',
                tokenId: 'test',
                tokenCiphertext: 'not-a-token'
            })
            await db.insert(runtimeHosts).values({
                id: daemonId,
                userId,
                daemonUuid: suffix,
                name: suffix,
                homeDir: dir
            })
            for (const kind of ['sprites', 'k8s', 'daemon'] as const) {
                const runtimeId = `art_${kind}_${suffix}`
                const agentId = `agt_${kind}_${suffix}`
                await db.insert(agentRuntimes).values({
                    id: runtimeId,
                    userId,
                    name: kind,
                    framework: 'codex',
                    kind
                })
                const [agent] = await db
                    .insert(agents)
                    .values({
                        id: agentId,
                        userId,
                        runtimeId,
                        internalId: agentId,
                        name: kind,
                        runtime: kind,
                        framework: 'codex',
                        status: 'running',
                        mountPath: workspace,
                        spriteName: `sprite-${suffix}`,
                        accountId: kind === 'sprites' ? accountId : null,
                        daemonId: kind === 'daemon' ? daemonId : null,
                        namespace: kind === 'k8s' ? 'test' : null
                    })
                    .returning()
                const key = workspaceOperationKey(agent)
                keys.push(`workspace-backup:${key}`)
                await writeFile(join(workspace, 'content'), `${kind}-before`)
                held = true
                releaseUpload = undefined
                const admissions = await Promise.allSettled([
                    first.createBackup(userId, agentId, false),
                    peer.createBackup(userId, agentId, false)
                ])
                const admitted = admissions.filter(
                    (result) => result.status === 'fulfilled'
                )
                assert.equal(
                    admitted.length,
                    1,
                    'only one simultaneous request can own the workspace'
                )
                const rejected = admissions.find(
                    (result) => result.status === 'rejected'
                )
                assert.ok(
                    rejected?.status === 'rejected' &&
                        rejected.reason instanceof ConflictException
                )
                const { backup } = (
                    admitted[0] as PromiseFulfilledResult<
                        Awaited<ReturnType<BackupsService['createBackup']>>
                    >
                ).value
                for (let n = 0; !releaseUpload; n++) {
                    assert.ok(n < 100)
                    await delay(20)
                }
                await assert.rejects(
                    peer.createBackup(userId, agentId, false),
                    ConflictException
                )
                const [coResident] = await db
                    .insert(agents)
                    .values({
                        id: `${agentId}_peer`,
                        userId,
                        runtimeId,
                        internalId: `${agentId}_peer`,
                        name: `${kind}-peer`,
                        runtime: kind,
                        framework: 'codex',
                        status: 'running',
                        mountPath: `${workspace}/./`,
                        spriteName: agent.spriteName,
                        accountId: agent.accountId,
                        daemonId: agent.daemonId,
                        namespace: agent.namespace
                    })
                    .returning()
                assert.equal(workspaceOperationKey(coResident), key)
                await assert.rejects(
                    peer.createBackup(userId, coResident.id, false),
                    ConflictException
                )
                const independent = await peerOperations.claim(
                    workspaceOperationKey({
                        ...coResident,
                        mountPath: join(dir, 'other')
                    }),
                    `independent_${suffix}`
                )
                assert.ok(
                    independent,
                    'a separate workspace must not share the lock'
                )
                await independent.close()
                // Any valid older restore point would pass the read checks, so use a completed synthetic row.
                const [old] = await db
                    .insert(agentBackups)
                    .values({
                        id: `abk_old_${kind}_${suffix}`,
                        userId,
                        sourceAgentId: agentId,
                        sourceAgentName: kind,
                        framework: 'codex',
                        runtimeKind: kind,
                        status: 'succeeded',
                        objectKey: 'unused'
                    })
                    .returning()
                await assert.rejects(
                    peer.restoreToAgent(userId, agentId, old.id, false),
                    ConflictException
                )
                await peer.onModuleInit()
                const [live] = await db
                    .select()
                    .from(agentBackups)
                    .where(eq(agentBackups.id, backup.id))
                assert.equal(live.status, 'running')
                peer.onModuleDestroy()
                held = false
                ;(releaseUpload as unknown as () => void)()
                assert.equal((await settle(backup.id)).status, 'succeeded')
                await writeFile(join(workspace, 'content'), `${kind}-after`)
                const restore = await peer.restoreToAgent(
                    userId,
                    agentId,
                    backup.id,
                    false
                )
                assert.equal(
                    (await settle(restore.id, true)).status,
                    'succeeded'
                )
                assert.equal(
                    await readFile(join(workspace, 'content'), 'utf8'),
                    `${kind}-before`
                )

                failUpload = true
                const failed = await first.createBackup(userId, agentId, false)
                assert.equal((await settle(failed.backup.id)).status, 'failed')
                failUpload = false
                const retried = await peer.createBackup(userId, agentId, false)
                assert.equal(
                    (await settle(retried.backup.id)).status,
                    'succeeded'
                )

                const abandonedId = `abk_abandoned_${kind}_${suffix}`
                const staleClaim = await operations.claim(key, abandonedId)
                assert.ok(staleClaim)
                await db.insert(agentBackups).values({
                    id: abandonedId,
                    userId,
                    sourceAgentId: agentId,
                    sourceAgentName: kind,
                    framework: 'codex',
                    runtimeKind: kind,
                    objectKey: abandonedId,
                    operationKey: key
                })
                await db
                    .update(serviceLeases)
                    .set({ expiresAt: new Date(0) })
                    .where(eq(serviceLeases.name, `workspace-backup:${key}`))
                await assert.rejects(staleClaim.assertOwned(), /lease lost/)
                const resumed = await peer.createBackup(userId, agentId, false)
                await staleClaim.close()
                const [abandoned] = await db
                    .select()
                    .from(agentBackups)
                    .where(eq(agentBackups.id, abandonedId))
                assert.equal(abandoned.status, 'failed')
                assert.ok(abandoned.operationReleasedAt)
                assert.equal(
                    (await settle(resumed.backup.id)).status,
                    'succeeded'
                )
            }
        } finally {
            held = false
            releaseUpload?.()
            for (const service of createdServices) service.onModuleDestroy()
            await db.delete(users).where(eq(users.id, userId))
            await db
                .delete(spritesAccounts)
                .where(eq(spritesAccounts.id, accountId))
            if (keys.length)
                await db
                    .delete(serviceLeases)
                    .where(inArray(serviceLeases.name, keys))
            await db.$client.end()
            await peerDb.$client.end()
            for (const key of keys)
                await rm(
                    dirname(
                        workspaceOperationRoot(
                            key.slice('workspace-backup:'.length),
                            'cleanup'
                        )
                    ),
                    { recursive: true, force: true }
                )
            await rm(dir, { recursive: true })
        }
    }
)
