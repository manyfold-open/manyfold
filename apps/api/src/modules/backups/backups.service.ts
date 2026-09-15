import {
    AgentBackupRestoreSummary,
    AgentBackupSummary,
    CreateAgentBackupResponse,
    createObjectId
} from '@manyfold/shared'
import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException,
    type OnModuleDestroy,
    type OnModuleInit
} from '@nestjs/common'
import { and, desc, eq, isNull, isNotNull, or, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
    agentBackupRestores,
    agentBackups,
    agents,
    type Agent,
    type AgentBackupRestoreRow,
    type AgentBackupRow,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { assertAgentReady } from '@/modules/agents/files/files-context'
import {
    BackupStorageService,
    meteredStream
} from '@/modules/backups/backup-storage.service'
import {
    WorkspaceRuntimeService,
    workspaceOperationKey
} from '@/modules/backups/workspace-runtime.service'
import {
    BackupOperationsService,
    type BackupOperationClaim
} from './backup-operations.service'

interface ListBackupsOptions {
    callerUserId: string
    isAdmin: boolean
    userId?: string
    agentId?: string
}

interface RestoreForCreateInput {
    actorUserId: string
    isAdmin: boolean
    backupId: string
    agent: Agent
}

@Injectable()
export class BackupsService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(BackupsService.name)
    private timer: NodeJS.Timeout | null = null
    private recovering = false
    private readonly claims = new Map<string, BackupOperationClaim>()

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly storage: BackupStorageService,
        private readonly runtime: WorkspaceRuntimeService,
        private readonly operations: BackupOperationsService
    ) {}

    async onModuleInit(): Promise<void> {
        await this.recoverInterrupted()
        this.timer = setInterval(() => {
            void this.recoverInterrupted().catch((err) => {
                this.log.warn(`backup recovery failed: ${sanitizeError(err)}`)
            })
        }, 60_000)
        this.timer.unref()
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer)
    }

    private async recoverInterrupted(): Promise<void> {
        if (this.recovering) return
        this.recovering = true
        try {
            for (const table of [agentBackups, agentBackupRestores]) {
                const rows = await this.db
                    .select()
                    .from(table)
                    .where(
                        and(
                            isNotNull(table.operationKey),
                            isNull(table.operationReleasedAt)
                        )
                    )
                    .limit(50)
                for (const row of rows) {
                    const key = row.operationKey!
                    const claim = await this.operations.claim(key, randomUUID())
                    if (!claim) continue
                    try {
                        await this.recoverKey(key, claim)
                    } catch (err) {
                        this.log.warn(
                            `backup recovery pending: ${sanitizeError(err)}`
                        )
                    } finally {
                        await claim.close()
                    }
                }
            }
        } catch (err) {
            if (!isUndefinedTableError(err)) throw err
            this.log.warn(
                'backup tables are missing; skipping interrupted backup cleanup until migrations run'
            )
        } finally {
            this.recovering = false
        }
    }

    private async admit(
        agent: Agent,
        operationId: string
    ): Promise<BackupOperationClaim> {
        const key = workspaceOperationKey(agent)
        const claim = await this.operations.claim(key, operationId)
        if (!claim)
            throw new ConflictException(
                'a backup or restore is already running for this workspace'
            )
        try {
            await this.recoverKey(key, claim, agent.id)
            await claim.assertOwned()
            this.claims.set(operationId, claim)
            return claim
        } catch (err) {
            await claim.close()
            throw err
        }
    }

    private async recoverKey(
        key: string,
        claim: BackupOperationClaim,
        agentId?: string
    ): Promise<void> {
        for (const table of [agentBackups, agentBackupRestores]) {
            const isRestore = table === agentBackupRestores
            const agentColumn = isRestore
                ? agentBackupRestores.targetAgentId
                : agentBackups.sourceAgentId
            const rows = await this.db
                .select({
                    id: table.id,
                    status: table.status,
                    operationKey: table.operationKey,
                    targetId: agentColumn,
                    objectKey: isRestore
                        ? sql<string | null>`null`
                        : agentBackups.objectKey
                })
                .from(table)
                .where(
                    or(
                        and(
                            eq(table.operationKey, key),
                            isNull(table.operationReleasedAt)
                        ),
                        agentId
                            ? and(
                                  eq(agentColumn, agentId),
                                  isNull(table.operationKey),
                                  eq(table.status, 'running')
                              )
                            : undefined
                    )
                )
            for (const row of rows) {
                await claim.assertOwned()
                if (!row.operationKey)
                    throw new ConflictException(
                        'a legacy backup or restore must finish before another workspace operation'
                    )
                if (row.status === 'running') {
                    await this.db
                        .update(table)
                        .set({
                            status: 'failed',
                            errorMessage:
                                'workspace operation interrupted; awaiting cleanup before retry',
                            completedAt: new Date(),
                            updatedAt: new Date()
                        })
                        .where(
                            and(
                                eq(table.id, row.id),
                                eq(table.status, 'running')
                            )
                        )
                }
                const targetId = row.targetId
                const agent = targetId ? await this.getAgentRow(targetId) : null
                if (!agent || workspaceOperationKey(agent) !== key)
                    throw new ConflictException(
                        'the interrupted workspace location needs reconciliation'
                    )
                if (!(await this.runtime.operationIsIdle(agent, row.id)))
                    throw new ConflictException(
                        'an interrupted workspace operation is still stopping; retry later'
                    )
                await claim.assertOwned()
                await this.runtime.recoverOperation(agent, row.id, isRestore)
                if (row.objectKey && row.status !== 'succeeded')
                    await this.storage.deleteObject(row.objectKey)
                await claim.assertOwned()
                const now = new Date()
                await this.db
                    .update(table)
                    .set({
                        ...(row.status === 'running'
                            ? {
                                  status: 'failed' as const,
                                  errorMessage:
                                      'workspace operation interrupted; retry is available',
                                  completedAt: now
                              }
                            : {}),
                        operationReleasedAt: now,
                        updatedAt: now
                    })
                    .where(eq(table.id, row.id))
            }
        }
    }

    async listBackups(opts: ListBackupsOptions): Promise<AgentBackupSummary[]> {
        this.storage.assertConfigured()
        const filters = [isNull(agentBackups.deletedAt)]
        if (opts.agentId)
            filters.push(eq(agentBackups.sourceAgentId, opts.agentId))
        if (opts.isAdmin) {
            if (opts.userId) filters.push(eq(agentBackups.userId, opts.userId))
        } else {
            filters.push(eq(agentBackups.userId, opts.callerUserId))
        }
        const rows = await this.db
            .select()
            .from(agentBackups)
            .where(and(...filters))
            .orderBy(desc(agentBackups.createdAt))
        return rows.map(toBackupSummary)
    }

    async createBackup(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<CreateAgentBackupResponse> {
        this.storage.assertConfigured()
        const agent = await this.loadAgent(callerUserId, agentId, isAdmin)
        assertAgentReady(agent)
        const backupId = createObjectId('agentBackup')
        const objectKey = this.storage.objectKey({
            userId: agent.userId,
            agentId: agent.id,
            backupId
        })
        const claim = await this.admit(agent, backupId)
        const now = new Date()
        let backup: AgentBackupRow
        try {
            const rows = await this.db
                .insert(agentBackups)
                .values({
                    id: backupId,
                    userId: agent.userId,
                    sourceAgentId: agent.id,
                    sourceAgentName: agent.name,
                    framework: agent.framework,
                    runtimeKind: agent.runtime,
                    status: 'running',
                    objectKey,
                    operationKey: workspaceOperationKey(agent),
                    startedAt: now,
                    createdAt: now,
                    updatedAt: now
                })
                .returning()
            backup = rows[0]
        } catch (err) {
            this.claims.delete(backupId)
            await claim.close()
            throw err
        }

        void this.runBackupJob(backup.id).catch((err) => {
            this.log.warn(
                `backup job ${backup.id} failed: ${(err as Error).message}`
            )
        })

        return { backup: toBackupSummary(backup) }
    }

    async deleteBackup(
        callerUserId: string,
        backupId: string,
        isAdmin: boolean
    ): Promise<void> {
        this.storage.assertConfigured()
        const backup = await this.loadBackup(callerUserId, backupId, isAdmin)
        if (backup.status === 'running')
            throw new ConflictException('cannot delete a running backup')
        if (await this.hasRunningRestore(backup.id))
            throw new ConflictException(
                'cannot delete a backup while a restore from it is running'
            )
        await this.storage.deleteObject(backup.objectKey)
        await this.markBackupDeleted(backup.id)
    }

    async restoreToAgent(
        callerUserId: string,
        agentId: string,
        backupId: string,
        isAdmin: boolean
    ): Promise<AgentBackupRestoreSummary> {
        this.storage.assertConfigured()
        const agent = await this.loadAgent(callerUserId, agentId, isAdmin)
        assertAgentReady(agent)
        const backup = await this.loadUsableBackupForAgent(
            callerUserId,
            backupId,
            agent,
            isAdmin
        )
        const restore = await this.admitRestore(backup.id, agent)
        void this.runRestoreJob(restore.id, false).catch((err) => {
            this.log.warn(
                `restore job ${restore.id} failed: ${(err as Error).message}`
            )
        })
        return toRestoreSummary(restore)
    }

    async getRestore(
        callerUserId: string,
        restoreId: string,
        isAdmin: boolean
    ): Promise<AgentBackupRestoreSummary> {
        this.storage.assertConfigured()
        const [row] = await this.db
            .select()
            .from(agentBackupRestores)
            .where(eq(agentBackupRestores.id, restoreId))
            .limit(1)
        if (!row || (!isAdmin && row.userId !== callerUserId))
            throw new NotFoundException(`restore ${restoreId} not found`)
        return toRestoreSummary(row)
    }

    async restoreBackupToAgentForCreate(
        input: RestoreForCreateInput
    ): Promise<AgentBackupRestoreSummary> {
        this.storage.assertConfigured()
        const backup = await this.loadUsableBackupForAgent(
            input.actorUserId,
            input.backupId,
            input.agent,
            input.isAdmin
        )
        const restore = await this.admitRestore(backup.id, input.agent)
        await this.runRestoreJob(restore.id, true)
        return this.getRestore(input.actorUserId, restore.id, input.isAdmin)
    }

    private async runBackupJob(backupId: string): Promise<void> {
        const claim = this.claims.get(backupId)
        if (!claim) throw new Error('backup operation has no admission claim')
        try {
            await this.executeBackupJob(backupId, claim)
        } finally {
            this.claims.delete(backupId)
            await claim.close()
        }
    }

    private async executeBackupJob(
        backupId: string,
        claim: BackupOperationClaim
    ): Promise<void> {
        const backup = await this.getBackupRow(backupId)
        if (!backup) return
        const agent = backup.sourceAgentId
            ? await this.getAgentRow(backup.sourceAgentId)
            : null
        if (!agent) {
            await this.failBackup(backup.id, 'source agent no longer exists')
            return
        }
        let archivePath: string | null = null
        try {
            await claim.assertOwned()
            if (
                backup.operationKey &&
                workspaceOperationKey(agent) !== backup.operationKey
            )
                throw new Error(
                    'workspace location changed after backup admission'
                )
            const archive = await this.runtime.createArchive(agent, backup.id)
            archivePath = archive.path
            await claim.assertOwned()
            const uploaded = await this.storage.upload(
                backup.objectKey,
                archive.stream,
                claim.signal
            )
            await claim.assertOwned()
            if (uploaded.bytes !== archive.archiveBytes)
                throw new Error(
                    `archive upload size mismatch ${uploaded.bytes}/${archive.archiveBytes}`
                )
            const now = new Date()
            await this.runtime.cleanupPath(agent, archivePath)
            archivePath = null
            await claim.assertOwned()
            await this.db
                .update(agentBackups)
                .set({
                    status: 'succeeded',
                    operationReleasedAt: now,
                    archiveBytes: uploaded.bytes,
                    workspaceBytes: archive.workspaceBytes,
                    fileCount: archive.fileCount,
                    sha256: uploaded.sha256,
                    errorMessage: null,
                    completedAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(agentBackups.id, backup.id),
                        eq(agentBackups.status, 'running')
                    )
                )
            await this.enforceRetention(agent.userId, agent.id).catch((err) => {
                this.log.warn(`backup retention failed: ${sanitizeError(err)}`)
            })
        } catch (err) {
            if (await claim.ownsLease()) {
                await this.storage
                    .deleteObject(backup.objectKey)
                    .catch(() => {})
                await this.failBackup(backup.id, sanitizeError(err))
            }
        } finally {
            if (archivePath) await this.runtime.cleanupPath(agent, archivePath)
        }
    }

    private async runRestoreJob(
        restoreId: string,
        throwOnError: boolean
    ): Promise<void> {
        const claim = this.claims.get(restoreId)
        if (!claim) throw new Error('restore operation has no admission claim')
        try {
            await this.executeRestoreJob(restoreId, throwOnError, claim)
        } finally {
            this.claims.delete(restoreId)
            await claim.close()
        }
    }

    private async executeRestoreJob(
        restoreId: string,
        throwOnError: boolean,
        claim: BackupOperationClaim
    ): Promise<void> {
        const restore = await this.getRestoreRow(restoreId)
        if (!restore) return
        const backup = await this.getBackupRow(restore.backupId)
        const agent = restore.targetAgentId
            ? await this.getAgentRow(restore.targetAgentId)
            : null
        let archivePath: string | null = null
        try {
            await claim.assertOwned()
            if (!backup || backup.status !== 'succeeded' || backup.deletedAt)
                throw new Error('backup is not available')
            if (!agent) throw new Error('target agent no longer exists')
            if (
                restore.operationKey &&
                workspaceOperationKey(agent) !== restore.operationKey
            )
                throw new Error(
                    'workspace location changed after restore admission'
                )
            if (backup.userId !== agent.userId)
                throw new Error(
                    'backup owner does not match target agent owner'
                )
            const download = await this.storage.download(
                backup.objectKey,
                claim.signal
            )
            const metered = meteredStream(download.stream)
            const meteredResult = metered.result
            meteredResult.catch(() => {})
            archivePath = await this.runtime.writeRestoreArchive(
                agent,
                restore.id,
                metered.stream
            )
            const actual = await meteredResult
            await claim.assertOwned()
            if (backup.archiveBytes && actual.bytes !== backup.archiveBytes)
                throw new Error(
                    `backup size mismatch ${actual.bytes}/${backup.archiveBytes}`
                )
            if (backup.sha256 && actual.sha256 !== backup.sha256)
                throw new Error('backup sha256 mismatch')
            await this.runtime.applyRestoreArchive(
                agent,
                restore.id,
                archivePath
            )
            await claim.assertOwned()
            archivePath = null
            await this.runtime.recoverOperation(agent, restore.id, true)
            await claim.assertOwned()
            const now = new Date()
            await this.db
                .update(agentBackupRestores)
                .set({
                    status: 'succeeded',
                    operationReleasedAt: now,
                    errorMessage: null,
                    completedAt: now,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(agentBackupRestores.id, restore.id),
                        eq(agentBackupRestores.status, 'running')
                    )
                )
        } catch (err) {
            const message = sanitizeError(err)
            if (await claim.ownsLease())
                await this.db
                    .update(agentBackupRestores)
                    .set({
                        status: 'failed',
                        errorMessage: message,
                        completedAt: new Date(),
                        updatedAt: new Date()
                    })
                    .where(
                        and(
                            eq(agentBackupRestores.id, restore.id),
                            eq(agentBackupRestores.status, 'running')
                        )
                    )
            if (throwOnError) throw new ServiceUnavailableException(message)
        } finally {
            if (archivePath && agent)
                await this.runtime.cleanupPath(agent, archivePath)
        }
    }

    private async enforceRetention(
        userId: string,
        agentId: string
    ): Promise<void> {
        const limit = this.storage.retentionCount()
        const rows = await this.db
            .select()
            .from(agentBackups)
            .where(
                and(
                    eq(agentBackups.userId, userId),
                    eq(agentBackups.sourceAgentId, agentId),
                    eq(agentBackups.status, 'succeeded'),
                    isNull(agentBackups.deletedAt)
                )
            )
            .orderBy(
                desc(agentBackups.completedAt),
                desc(agentBackups.createdAt)
            )
        for (const row of rows.slice(limit)) {
            // A restore re-reads its backup while it runs, so reaping one now
            // would fail that restore and take the chosen restore point with it.
            // It stays one cycle longer; the next successful backup reaps it.
            if (await this.hasRunningRestore(row.id)) continue
            await this.storage.deleteObject(row.objectKey).catch((err) => {
                this.log.warn(
                    `retention delete failed backup=${row.id}: ${(err as Error).message}`
                )
            })
            await this.markBackupDeleted(row.id)
        }
    }

    private async hasRunningRestore(backupId: string): Promise<boolean> {
        const [row] = await this.db
            .select({ id: agentBackupRestores.id })
            .from(agentBackupRestores)
            .where(
                and(
                    eq(agentBackupRestores.backupId, backupId),
                    eq(agentBackupRestores.status, 'running')
                )
            )
            .limit(1)
        return !!row
    }

    private async loadAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<Agent> {
        const agent = await this.getAgentRow(agentId)
        if (!agent || (!isAdmin && agent.userId !== callerUserId))
            throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    private async loadBackup(
        callerUserId: string,
        backupId: string,
        isAdmin: boolean
    ): Promise<AgentBackupRow> {
        const backup = await this.getBackupRow(backupId)
        if (
            !backup ||
            backup.deletedAt ||
            backup.status === 'deleted' ||
            (!isAdmin && backup.userId !== callerUserId)
        )
            throw new NotFoundException(`backup ${backupId} not found`)
        return backup
    }

    private async loadUsableBackupForAgent(
        callerUserId: string,
        backupId: string,
        agent: Agent,
        isAdmin: boolean
    ): Promise<AgentBackupRow> {
        const backup = await this.loadBackup(callerUserId, backupId, isAdmin)
        if (backup.status !== 'succeeded')
            throw new ConflictException('backup is not ready')
        if (backup.userId !== agent.userId)
            throw new NotFoundException(`backup ${backupId} not found`)
        return backup
    }

    private async createRestoreRow(
        backupId: string,
        agent: Agent,
        restoreId: string
    ): Promise<AgentBackupRestoreRow> {
        const now = new Date()
        const [restore] = await this.db
            .insert(agentBackupRestores)
            .values({
                id: restoreId,
                userId: agent.userId,
                backupId,
                targetAgentId: agent.id,
                status: 'running',
                mode: 'replace',
                operationKey: workspaceOperationKey(agent),
                startedAt: now,
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return restore
    }

    private async admitRestore(
        backupId: string,
        agent: Agent
    ): Promise<AgentBackupRestoreRow> {
        const id = createObjectId('agentBackupRestore')
        const claim = await this.admit(agent, id)
        try {
            return await this.createRestoreRow(backupId, agent, id)
        } catch (err) {
            this.claims.delete(id)
            await claim.close()
            throw err
        }
    }

    private async getAgentRow(agentId: string): Promise<Agent | null> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        return agent ?? null
    }

    private async getBackupRow(
        backupId: string
    ): Promise<AgentBackupRow | null> {
        const [row] = await this.db
            .select()
            .from(agentBackups)
            .where(eq(agentBackups.id, backupId))
            .limit(1)
        return row ?? null
    }

    private async getRestoreRow(
        restoreId: string
    ): Promise<AgentBackupRestoreRow | null> {
        const [row] = await this.db
            .select()
            .from(agentBackupRestores)
            .where(eq(agentBackupRestores.id, restoreId))
            .limit(1)
        return row ?? null
    }

    private async failBackup(id: string, message: string): Promise<void> {
        await this.db
            .update(agentBackups)
            .set({
                status: 'failed',
                errorMessage: message,
                completedAt: new Date(),
                updatedAt: new Date()
            })
            .where(
                and(eq(agentBackups.id, id), eq(agentBackups.status, 'running'))
            )
    }

    private async markBackupDeleted(id: string): Promise<void> {
        const now = new Date()
        await this.db
            .update(agentBackups)
            .set({
                status: 'deleted',
                deletedAt: now,
                updatedAt: now
            })
            .where(eq(agentBackups.id, id))
    }
}

const toBackupSummary = (row: AgentBackupRow): AgentBackupSummary => ({
    id: row.id,
    userId: row.userId,
    sourceAgentId: row.sourceAgentId,
    sourceAgentName: row.sourceAgentName,
    framework: row.framework,
    runtimeKind: row.runtimeKind,
    status: row.status,
    objectKey: row.objectKey,
    archiveBytes: row.archiveBytes,
    workspaceBytes: row.workspaceBytes,
    fileCount: row.fileCount,
    sha256: row.sha256,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const toRestoreSummary = (
    row: AgentBackupRestoreRow
): AgentBackupRestoreSummary => ({
    id: row.id,
    userId: row.userId,
    backupId: row.backupId,
    targetAgentId: row.targetAgentId,
    status: row.status,
    mode: row.mode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const sanitizeError = (err: unknown): string =>
    ((err as Error)?.message ?? 'unknown error')
        .slice(0, 512)
        .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')

const isUndefinedTableError = (err: unknown): boolean =>
    (err as { code?: string } | null)?.code === '42P01'
