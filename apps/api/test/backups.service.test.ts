import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ConflictException, ServiceUnavailableException } from '@nestjs/common'
import type { ConfigService } from '@nestjs/config'
import { agentBackupRestores, agentBackups, agents } from '@manyfold/db'
import type { ResourceChangesService } from '../src/modules/resource-events/resource-changes.service'
import {
    BackupStorageService,
    meteredStream
} from '../src/modules/backups/backup-storage.service'
import { BackupsService } from '../src/modules/backups/backups.service'
import type { BackupOperationClaim } from '../src/modules/backups/backup-operations.service'

const now = new Date('2026-04-29T12:00:00.000Z')

test('BackupStorageService reports missing S3 config as unavailable', () => {
    const service = new BackupStorageService(config({}))

    assert.throws(() => service.assertConfigured(), ServiceUnavailableException)
})

test('BackupStorageService builds safe object keys and retention defaults', () => {
    const service = new BackupStorageService(
        config({
            BACKUP_S3_ENDPOINT: 'https://s3.test',
            BACKUP_S3_BUCKET: 'nca-backups',
            BACKUP_S3_ACCESS_KEY_ID: 'access',
            BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
            BACKUP_S3_PREFIX: '/team backups/'
        })
    )

    assert.equal(
        service.objectKey({
            userId: 'user/one',
            agentId: 'agent one',
            backupId: 'backup:1'
        }),
        'team backups/user_one/agent_one/backup_1.tar.gz'
    )
    assert.equal(service.retentionCount(), 20)
})

test('meteredStream forwards chunks while calculating bytes and sha256', async () => {
    const metered = meteredStream(chunks('hello', 'backup'))
    const received: Buffer[] = []

    for await (const chunk of metered.stream) received.push(Buffer.from(chunk))

    assert.equal(Buffer.concat(received).toString('utf8'), 'hellobackup')
    assert.deepEqual(await metered.result, {
        bytes: 11,
        sha256: sha256('hellobackup')
    })
})

test('an already-aborted backup upload rejects without leaking a stream error', async () => {
    const service = new BackupStorageService(
        config({
            BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9',
            BACKUP_S3_BUCKET: 'test',
            BACKUP_S3_ACCESS_KEY_ID: 'test',
            BACKUP_S3_SECRET_ACCESS_KEY: 'test'
        })
    )
    const controller = new AbortController()
    controller.abort(new Error('cancelled before upload'))
    await assert.rejects(
        service.upload('test', chunks('payload'), controller.signal),
        /cancelled before upload/
    )
    await new Promise((resolve) => setImmediate(resolve))
})

test('archive stream failure reaches the upload caller', async () => {
    const service = new BackupStorageService(
        config({
            BACKUP_S3_ENDPOINT: 'http://127.0.0.1:9',
            BACKUP_S3_BUCKET: 'test',
            BACKUP_S3_ACCESS_KEY_ID: 'test',
            BACKUP_S3_SECRET_ACCESS_KEY: 'test'
        })
    )
    const source = async function* () {
        yield Buffer.from('partial')
        throw new Error('archive stream interrupted')
    }
    await assert.rejects(
        service.upload('test', source()),
        /archive stream interrupted/
    )
})

test('BackupsService startup cleanup skips missing backup tables before migration', async () => {
    const db = new FakeBackupsDb()
    db.updateError = Object.assign(new Error('relation does not exist'), {
        code: '42P01'
    })
    const service = serviceFor(db, new FakeStorage(), new FakeRuntime())

    await service.onModuleInit()
    service.onModuleDestroy()
})

test('BackupsService startup cleanup rethrows unexpected database errors', async () => {
    const db = new FakeBackupsDb()
    db.updateError = Object.assign(new Error('permission denied'), {
        code: '42501'
    })
    const service = serviceFor(db, new FakeStorage(), new FakeRuntime())

    await assert.rejects(() => service.onModuleInit(), /permission denied/)
})

test('BackupsService rejects a peer restore while the workspace archive is running', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(backupRow({ status: 'succeeded' }))
    const storage = new FakeStorage()
    const runtime = new FakeRuntime()
    const archive = holdArchive(runtime)
    const first = serviceFor(db, storage, runtime)
    const peer = serviceFor(db, storage, runtime)
    // Track both mutable arrays so even a wrongly admitted detached restore settles.
    const firstJobs = trackJobs(first)
    const peerJobs = trackJobs(peer)
    try {
        await first.createBackup('user-1', 'agent-1', false)
        await archive.started
        await assert.rejects(
            peer.restoreToAgent('user-1', 'agent-1', 'backup-1', false),
            ConflictException
        )
        assert.equal(runtime.applied.length, 0)
        assert.equal(db.restoreRows.length, 0)
    } finally {
        archive.release()
        await Promise.all([...firstJobs, ...peerJobs])
    }
})

test('BackupsService startup preserves a peer backup that is still archiving', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    const storage = new FakeStorage()
    const runtime = new FakeRuntime()
    const archive = holdArchive(runtime)
    const first = serviceFor(db, storage, runtime)
    const peer = serviceFor(db, storage, runtime)
    const jobs = trackJobs(first)
    try {
        const { backup } = await first.createBackup('user-1', 'agent-1', false)
        await archive.started
        await peer.onModuleInit()
        assert.equal(
            db.backupRows.find((row) => row.id === backup.id)?.status,
            'running',
            'another API startup must not invalidate an active archive'
        )
    } finally {
        archive.release()
        await Promise.all(jobs)
        peer.onModuleDestroy()
    }
})

test('BackupsService marks backup succeeded and cleans runtime archive', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(backupRow({ status: 'running' }))
    const storage = new FakeStorage()
    const runtime = new FakeRuntime()
    runtime.archiveData = 'archive-data'
    runtime.archiveBytes = Buffer.byteLength(runtime.archiveData)
    const events: unknown[] = []
    const service = serviceFor(db, storage, runtime, {
        emit: (userId: string, change: unknown) => {
            assert.equal(db.backupRows[0].status, 'succeeded')
            events.push({ userId, change })
        }
    } as ResourceChangesService)

    await privateApi(service).runBackupJob('backup-1')

    assert.equal(db.backupRows[0].status, 'succeeded')
    assert.deepEqual(events, [{ userId: 'user-1', change: {
        resource: 'backup', resourceId: 'backup-1', agentId: 'agent-1', reason: 'updated'
    } }])
    assert.equal(db.backupRows[0].archiveBytes, runtime.archiveBytes)
    assert.equal(db.backupRows[0].workspaceBytes, 123)
    assert.equal(db.backupRows[0].fileCount, 4)
    assert.equal(db.backupRows[0].sha256, sha256(runtime.archiveData))
    assert.deepEqual(storage.uploads, ['object-key'])
    assert.deepEqual(runtime.cleaned, [
        '/workspace/.nca-backup-tmp/backup-1.tar.gz'
    ])
})

test('BackupsService records backup failure and removes partial object', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(backupRow({ status: 'running' }))
    const storage = new FakeStorage()
    storage.uploadError = new Error('upload failed')
    const runtime = new FakeRuntime()
    const events: unknown[] = []
    const service = serviceFor(db, storage, runtime, {
        emit: (userId: string, change: unknown) => {
            assert.equal(db.backupRows[0].status, 'failed')
            events.push({ userId, change })
        }
    } as ResourceChangesService)

    await privateApi(service).runBackupJob('backup-1')

    assert.equal(db.backupRows[0].status, 'failed')
    assert.deepEqual(events, [{ userId: 'user-1', change: {
        resource: 'backup', resourceId: 'backup-1', agentId: 'agent-1', reason: 'updated'
    } }])
    assert.equal(db.backupRows[0].errorMessage, 'upload failed')
    assert.deepEqual(storage.deleted, ['object-key'])
    assert.deepEqual(runtime.cleaned, [
        '/workspace/.nca-backup-tmp/backup-1.tar.gz'
    ])
})

test('retention failure does not delete a completed backup', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(backupRow())
    const storage = new FakeStorage()
    const service = serviceFor(db, storage, new FakeRuntime())
    privateApi(service).enforceRetention = async () => {
        throw new Error('retention unavailable')
    }
    await privateApi(service).runBackupJob('backup-1')
    assert.equal(db.backupRows[0].status, 'succeeded')
    assert.deepEqual(storage.deleted, [])
})

test('a stale restore completion cannot revive a recovery-failed row', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(backupRow({ status: 'succeeded' }))
    db.restoreRows.push(restoreRow())
    const runtime = new FakeRuntime()
    runtime.applyRestoreArchive = async () => {
        db.restoreRows[0].status = 'failed'
        db.restoreRows[0].errorMessage = 'interrupted by recovery'
        return { workspaceBytes: 1, fileCount: 1 }
    }
    const service = serviceFor(db, new FakeStorage(), runtime)
    await privateApi(service).runRestoreJob('restore-1', false)
    assert.equal(db.restoreRows[0].status, 'failed')
    assert.equal(db.restoreRows[0].errorMessage, 'interrupted by recovery')
})

test('BackupsService retention deletes objects beyond configured count', async () => {
    const db = new FakeBackupsDb()
    db.backupRows.push(
        backupRow({
            id: 'backup-new',
            objectKey: 'new-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T12:00:00.000Z')
        }),
        backupRow({
            id: 'backup-middle',
            objectKey: 'middle-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T11:00:00.000Z')
        }),
        backupRow({
            id: 'backup-old',
            objectKey: 'old-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T10:00:00.000Z')
        })
    )
    const storage = new FakeStorage()
    storage.retention = 2
    const service = serviceFor(db, storage, new FakeRuntime())

    await privateApi(service).enforceRetention('user-1', 'agent-1')

    assert.equal(db.backupRows[0].status, 'succeeded')
    assert.equal(db.backupRows[1].status, 'succeeded')
    assert.equal(db.backupRows[2].status, 'deleted')
    assert.ok(db.backupRows[2].deletedAt)
    assert.deepEqual(storage.deleted, ['old-key'])
})

// A restore re-reads its backup row and downloads the object while it runs. The
// web takes a safety snapshot right before restoring, so the snapshot completing
// is exactly when retention fires — reaping the restore's own source here fails
// the restore and destroys the restore point the user chose.
test('BackupsService retention spares a backup a running restore is reading', async () => {
    const db = new FakeBackupsDb()
    db.backupRows.push(
        backupRow({
            id: 'backup-new',
            objectKey: 'new-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T12:00:00.000Z')
        }),
        backupRow({
            id: 'backup-restoring',
            objectKey: 'restoring-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T11:00:00.000Z')
        }),
        backupRow({
            id: 'backup-old',
            objectKey: 'old-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T10:00:00.000Z')
        })
    )
    db.restoreRows.push(
        restoreRow({ id: 'restore-live', backupId: 'backup-restoring' })
    )
    const storage = new FakeStorage()
    storage.retention = 1
    const service = serviceFor(db, storage, new FakeRuntime())

    await privateApi(service).enforceRetention('user-1', 'agent-1')

    assert.equal(db.backupRows[1].status, 'succeeded')
    assert.equal(db.backupRows[1].deletedAt, null)
    // The one nothing is reading still goes.
    assert.equal(db.backupRows[2].status, 'deleted')
    assert.deepEqual(storage.deleted, ['old-key'])
})

test('BackupsService retention reaps a backup whose restore already settled', async () => {
    const db = new FakeBackupsDb()
    db.backupRows.push(
        backupRow({
            id: 'backup-new',
            objectKey: 'new-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T12:00:00.000Z')
        }),
        backupRow({
            id: 'backup-restored',
            objectKey: 'restored-key',
            status: 'succeeded',
            completedAt: new Date('2026-04-29T11:00:00.000Z')
        })
    )
    db.restoreRows.push(
        restoreRow({
            id: 'restore-done',
            backupId: 'backup-restored',
            status: 'succeeded'
        })
    )
    const storage = new FakeStorage()
    storage.retention = 1
    const service = serviceFor(db, storage, new FakeRuntime())

    await privateApi(service).enforceRetention('user-1', 'agent-1')

    assert.equal(db.backupRows[1].status, 'deleted')
    assert.deepEqual(storage.deleted, ['restored-key'])
})

test('BackupsService refuses to delete a backup a running restore is reading', async () => {
    const db = new FakeBackupsDb()
    db.backupRows.push(backupRow({ status: 'succeeded' }))
    db.restoreRows.push(restoreRow())
    const storage = new FakeStorage()
    const service = serviceFor(db, storage, new FakeRuntime())

    await assert.rejects(
        () => service.deleteBackup('user-1', 'backup-1', false),
        ConflictException
    )
    assert.equal(db.backupRows[0].status, 'succeeded')
    assert.deepEqual(storage.deleted, [])
})

test('BackupsService restores only after archive hash verification succeeds', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(
        backupRow({
            status: 'succeeded',
            archiveBytes: 7,
            sha256: sha256('restore')
        })
    )
    db.restoreRows.push(restoreRow())
    const storage = new FakeStorage()
    storage.downloadData = 'restore'
    const runtime = new FakeRuntime()
    const service = serviceFor(db, storage, runtime)

    await privateApi(service).runRestoreJob('restore-1', false)

    assert.equal(db.restoreRows[0].status, 'succeeded')
    assert.deepEqual(runtime.written, [
        {
            restoreId: 'restore-1',
            data: 'restore'
        }
    ])
    assert.deepEqual(runtime.applied, [
        {
            restoreId: 'restore-1',
            archivePath: '/workspace/.nca-backup-tmp/restore-restore-1.tar.gz'
        }
    ])
})

test('BackupsService restore hash mismatch does not replace workspace', async () => {
    const db = new FakeBackupsDb()
    db.agentRows.push(agentRow())
    db.backupRows.push(
        backupRow({
            status: 'succeeded',
            archiveBytes: 3,
            sha256: sha256('ok!')
        })
    )
    db.restoreRows.push(restoreRow())
    const storage = new FakeStorage()
    storage.downloadData = 'bad'
    const runtime = new FakeRuntime()
    const service = serviceFor(db, storage, runtime)

    await privateApi(service).runRestoreJob('restore-1', false)

    assert.equal(db.restoreRows[0].status, 'failed')
    assert.equal(db.restoreRows[0].errorMessage, 'backup sha256 mismatch')
    assert.deepEqual(runtime.applied, [])
    assert.deepEqual(runtime.cleaned, [
        '/workspace/.nca-backup-tmp/restore-restore-1.tar.gz'
    ])
})

const holdArchive = (runtime: FakeRuntime) => {
    let release!: () => void
    let signalStarted!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const started = new Promise<void>((resolve) => {
        signalStarted = resolve
    })
    const original = runtime.createArchive.bind(runtime)
    runtime.createArchive = async (agent, backupId) => {
        signalStarted()
        await gate
        return original(agent, backupId)
    }
    return { started, release }
}

const trackJobs = (service: BackupsService): Promise<void>[] => {
    const jobs: Promise<void>[] = []
    const runner = privateApi(service)
    const backup = runner.runBackupJob.bind(service)
    const restore = runner.runRestoreJob.bind(service)
    runner.runBackupJob = (id) => {
        const job = backup(id)
        jobs.push(job)
        return job
    }
    runner.runRestoreJob = (id, throwOnError) => {
        const job = restore(id, throwOnError)
        jobs.push(job)
        return job
    }
    return jobs
}

const config = (values: Record<string, string>): ConfigService =>
    ({
        get: (key: string) => values[key]
    }) as ConfigService

const chunks = async function* (
    ...values: string[]
): AsyncIterable<Uint8Array> {
    for (const value of values) yield Buffer.from(value)
}

const sha256 = (value: string): string =>
    createHash('sha256').update(value).digest('hex')

const serviceFor = (
    db: FakeBackupsDb,
    storage: FakeStorage,
    runtime: FakeRuntime,
    changes?: ResourceChangesService
): BackupsService => {
    const service = new BackupsService(
        db as never,
        storage as never,
        runtime as never,
        {
            claim: async (key: string, id: string) => {
                if (db.owners.has(key)) return null
                db.owners.set(key, id)
                return {
                    ...testClaim(),
                    close: async () => {
                        if (db.owners.get(key) === id) db.owners.delete(key)
                    }
                }
            }
        } as never,
        changes
    )
    const claims = (
        service as unknown as { claims: Map<string, BackupOperationClaim> }
    ).claims
    for (const row of [...db.backupRows, ...db.restoreRows])
        if (row.status === 'running') claims.set(String(row.id), testClaim())
    return service
}

const testClaim = (): BackupOperationClaim => ({
    signal: new AbortController().signal,
    assertOwned: async () => {},
    ownsLease: async () => true,
    close: async () => {}
})

const privateApi = (
    service: BackupsService
): {
    runBackupJob: (backupId: string) => Promise<void>
    runRestoreJob: (restoreId: string, throwOnError: boolean) => Promise<void>
    enforceRetention: (userId: string, agentId: string) => Promise<void>
} => service as never

const agentRow = (
    patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
    id: 'agent-1',
    userId: 'user-1',
    runtimeId: 'runtime-1',
    name: 'Agent',
    framework: 'codex',
    runtime: 'sprites',
    status: 'running',
    accountId: 'account-1',
    spriteName: 'sprite-1',
    mountPath: '/workspace',
    workspacePath: '/workspace',
    createdAt: now,
    updatedAt: now,
    ...patch
})

const backupRow = (
    patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
    id: 'backup-1',
    userId: 'user-1',
    sourceAgentId: 'agent-1',
    sourceAgentName: 'Agent',
    framework: 'codex',
    runtimeKind: 'sprites',
    status: 'running',
    objectKey: 'object-key',
    operationKey: null,
    operationReleasedAt: null,
    archiveBytes: 0,
    workspaceBytes: 0,
    fileCount: 0,
    sha256: null,
    errorMessage: null,
    startedAt: now,
    completedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch
})

const restoreRow = (
    patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
    id: 'restore-1',
    userId: 'user-1',
    backupId: 'backup-1',
    targetAgentId: 'agent-1',
    status: 'running',
    mode: 'replace',
    operationKey: null,
    operationReleasedAt: null,
    errorMessage: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch
})

class FakeStorage {
    uploads: string[] = []
    deleted: string[] = []
    uploadError: Error | null = null
    downloadData = ''
    retention = 20

    assertConfigured(): void {}

    retentionCount(): number {
        return this.retention
    }

    objectKey(): string {
        return 'object-key'
    }

    async upload(
        key: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<{ bytes: number; sha256: string }> {
        this.uploads.push(key)
        if (this.uploadError) throw this.uploadError
        const buffers: Buffer[] = []
        for await (const chunk of stream) buffers.push(Buffer.from(chunk))
        const body = Buffer.concat(buffers)
        return {
            bytes: body.length,
            sha256: createHash('sha256').update(body).digest('hex')
        }
    }

    async download(): Promise<{
        stream: AsyncIterable<Uint8Array>
        size: number
    }> {
        return {
            stream: chunks(this.downloadData),
            size: Buffer.byteLength(this.downloadData)
        }
    }

    async deleteObject(key: string): Promise<void> {
        this.deleted.push(key)
    }
}

class FakeRuntime {
    archiveData = 'archive'
    archiveBytes = Buffer.byteLength(this.archiveData)
    cleaned: string[] = []
    written: Array<{ restoreId: string; data: string }> = []
    applied: Array<{ restoreId: string; archivePath: string }> = []

    async operationIsIdle(): Promise<boolean> {
        return true
    }
    async recoverOperation(): Promise<void> {}

    async createArchive(
        _agent: unknown,
        backupId: string
    ): Promise<{
        path: string
        archiveBytes: number
        workspaceBytes: number
        fileCount: number
        stream: AsyncIterable<Uint8Array>
    }> {
        return {
            path: `/workspace/.nca-backup-tmp/${backupId}.tar.gz`,
            archiveBytes: this.archiveBytes,
            workspaceBytes: 123,
            fileCount: 4,
            stream: chunks(this.archiveData)
        }
    }

    async cleanupPath(_agent: unknown, absPath: string): Promise<void> {
        this.cleaned.push(absPath)
    }

    async writeRestoreArchive(
        _agent: unknown,
        restoreId: string,
        stream: AsyncIterable<Uint8Array>
    ): Promise<string> {
        const buffers: Buffer[] = []
        for await (const chunk of stream) buffers.push(Buffer.from(chunk))
        this.written.push({
            restoreId,
            data: Buffer.concat(buffers).toString('utf8')
        })
        return `/workspace/.nca-backup-tmp/restore-${restoreId}.tar.gz`
    }

    async applyRestoreArchive(
        _agent: unknown,
        restoreId: string,
        archivePath: string
    ): Promise<{ workspaceBytes: number; fileCount: number }> {
        this.applied.push({ restoreId, archivePath })
        return { workspaceBytes: 123, fileCount: 4 }
    }
}

class FakeBackupsDb {
    owners = new Map<string, string>()
    agentRows: Array<Record<string, unknown>> = []
    backupRows: Array<Record<string, unknown>> = []
    restoreRows: Array<Record<string, unknown>> = []
    updateError: Error | null = null

    select(selection?: Record<string, { name: string }>): {
        from: (table: unknown) => FakeSelectBuilder
    } {
        return {
            from: (table: unknown) => {
                if (this.updateError) throw this.updateError
                return new FakeSelectBuilder(this.rowsFor(table), selection)
            }
        }
    }

    insert(table: unknown): {
        values: (row: Record<string, unknown>) => {
            returning: () => Promise<Array<Record<string, unknown>>>
        }
    } {
        return {
            values: (row: Record<string, unknown>) => ({
                returning: async () => {
                    row = {
                        operationKey: null,
                        operationReleasedAt: null,
                        ...row
                    }
                    this.rowsFor(table).push(row)
                    return [row]
                }
            })
        }
    }

    update(table: unknown): {
        set: (patch: Record<string, unknown>) => {
            where: (condition?: unknown) => Promise<void> & {
                returning: () => Promise<Array<Record<string, unknown>>>
            }
        }
    } {
        return {
            set: (patch: Record<string, unknown>) => ({
                where: (condition?: unknown) => {
                    const rows = filterRows(this.rowsFor(table), condition)
                    const done = Promise.resolve().then(() => {
                        if (this.updateError) throw this.updateError
                        for (const row of rows) Object.assign(row, patch)
                    })
                    return Object.assign(done, {
                        returning: async () => { await done; return rows }
                    })
                }
            })
        }
    }

    private rowsFor(table: unknown): Array<Record<string, unknown>> {
        if (table === agents) return this.agentRows
        if (table === agentBackups) return this.backupRows
        if (table === agentBackupRestores) return this.restoreRows
        throw new Error('unknown table')
    }
}

class FakeSelectBuilder {
    constructor(
        private rows: Array<Record<string, unknown>>,
        private selection?: Record<string, { name: string }>
    ) {}

    private selected(): Array<Record<string, unknown>> {
        return this.selection
            ? this.rows.map((row) =>
                  Object.fromEntries(
                      Object.entries(this.selection!).map(([key, column]) => [
                          key,
                          row[columnToProperty(column.name)]
                      ])
                  )
              )
            : this.rows
    }

    where(condition?: unknown): FakeSelectBuilder {
        this.rows = filterRows(this.rows, condition)
        return this
    }

    orderBy(): Promise<Array<Record<string, unknown>>> {
        return Promise.resolve(this.selected())
    }

    limit(count: number): Promise<Array<Record<string, unknown>>> {
        return Promise.resolve(this.selected().slice(0, count))
    }

    then<TResult1 = Array<Record<string, unknown>>, TResult2 = never>(
        onfulfilled?:
            | ((
                  value: Array<Record<string, unknown>>
              ) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
        return Promise.resolve(this.selected()).then(onfulfilled, onrejected)
    }
}

const filterRows = (
    rows: Array<Record<string, unknown>>,
    condition?: unknown
): Array<Record<string, unknown>> => {
    const chunks = (condition as { queryChunks?: unknown[] } | undefined)
        ?.queryChunks
    const operator = chunks?.find((chunk) => {
        const raw = (chunk as { value?: unknown })?.value
        const value = Array.isArray(raw) ? raw.join('').trim() : undefined
        return value === 'or' || value === 'and'
    }) as { value: string[] } | undefined
    if (operator) {
        const children = chunks!.filter(
            (chunk) => (chunk as { queryChunks?: unknown[] })?.queryChunks
        )
        return rows.filter((row) =>
            operator.value.join('').trim() === 'or'
                ? children.some((child) => filterRows([row], child).length > 0)
                : children.every((child) => filterRows([row], child).length > 0)
        )
    }
    const filters = conditionFilters(condition)
    if (filters.length === 0) return rows
    return rows.filter((row) =>
        filters.every((filter) => {
            const actual = row[columnToProperty(filter.column)]
            return filter.op === 'null'
                ? actual == null
                : filter.op === 'notNull'
                  ? actual != null
                  : filter.op === 'eq'
                    ? actual === filter.value
                    : actual !== filter.value
        })
    )
}

interface ConditionFilter {
    column: string
    op: 'eq' | 'ne' | 'null' | 'notNull'
    value: unknown
}

const conditionFilters = (condition?: unknown): ConditionFilter[] => {
    if (!condition || typeof condition !== 'object') return []
    const chunks = (condition as { queryChunks?: unknown[] }).queryChunks
    if (!Array.isArray(chunks)) return []
    const filters: ConditionFilter[] = []
    for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] as {
            queryChunks?: unknown[]
            name?: string
        }
        filters.push(...conditionFilters(chunk))
        if (!chunk.name) continue
        const opText = String(
            (
                (chunks[index + 1] as { value?: string[] } | undefined)
                    ?.value ?? []
            )
                .join('')
                .trim()
        )
        const param = chunks[index + 2] as { value?: unknown } | undefined
        if (opText === '=')
            filters.push({ column: chunk.name, op: 'eq', value: param?.value })
        if (opText === '<>')
            filters.push({ column: chunk.name, op: 'ne', value: param?.value })
        if (opText === 'is null')
            filters.push({ column: chunk.name, op: 'null', value: null })
        if (opText === 'is not null')
            filters.push({ column: chunk.name, op: 'notNull', value: null })
    }
    return filters
}

const columnToProperty = (column: string): string =>
    column.replace(/_([a-z])/g, (_match, letter: string) =>
        letter.toUpperCase()
    )
