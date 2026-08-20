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
    type OnModuleInit
} from '@nestjs/common'
import { and, desc, eq, isNull, ne } from 'drizzle-orm'
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
import { WorkspaceRuntimeService } from '@/modules/backups/workspace-runtime.service'

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
export class BackupsService implements OnModuleInit {
    private readonly log = new Logger(BackupsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly storage: BackupStorageService,
        private readonly runtime: WorkspaceRuntimeService
    ) {}

    async onModuleInit(): Promise<void> {
        const now = new Date()
        try {
            await this.db
                .update(agentBackups)
                .set({
                    status: 'failed',
                    errorMessage: 'backup interrupted by API restart',
                    completedAt: now,
                    updatedAt: now
                })
                .where(eq(agentBackups.status, 'running'))
            await this.db
                .update(agentBackupRestores)
                .set({
                    status: 'failed',
                    errorMessage: 'restore interrupted by API restart',
                    completedAt: now,
                    updatedAt: now
                })
                .where(eq(agentBackupRestores.status, 'running'))
        } catch (err) {
            if (!isUndefinedTableError(err)) throw err
            this.log.warn(
                'backup tables are missing; skipping interrupted backup cleanup until migrations run'
            )
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
        const now = new Date()
        const [backup] = await this.db
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
                startedAt: now,
                createdAt: now,
                updatedAt: now
            })
            .returning()

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
        const restore = await this.createRestoreRow(backup.id, agent)
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
        const restore = await this.createRestoreRow(backup.id, input.agent)
        await this.runRestoreJob(restore.id, true)
        return this.getRestore(input.actorUserId, restore.id, input.isAdmin)
    }

    private async runBackupJob(backupId: string): Promise<void> {
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
            const archive = await this.runtime.createArchive(agent, backup.id)
            archivePath = archive.path
            const uploaded = await this.storage.upload(
                backup.objectKey,
                archive.stream
            )
            if (uploaded.bytes !== archive.archiveBytes)
                throw new Error(
                    `archive upload size mismatch ${uploaded.bytes}/${archive.archiveBytes}`
                )
            const now = new Date()
            await this.db
                .update(agentBackups)
                .set({
                    status: 'succeeded',
                    archiveBytes: uploaded.bytes,
                    workspaceBytes: archive.workspaceBytes,
                    fileCount: archive.fileCount,
                    sha256: uploaded.sha256,
                    errorMessage: null,
                    completedAt: now,
                    updatedAt: now
                })
                .where(eq(agentBackups.id, backup.id))
            await this.enforceRetention(agent.userId, agent.id)
        } catch (err) {
            await this.storage.deleteObject(backup.objectKey).catch(() => {})
            await this.failBackup(backup.id, sanitizeError(err))
        } finally {
            if (archivePath) await this.runtime.cleanupPath(agent, archivePath)
        }
    }

    private async runRestoreJob(
        restoreId: string,
        throwOnError: boolean
    ): Promise<void> {
        const restore = await this.getRestoreRow(restoreId)
        if (!restore) return
        const backup = await this.getBackupRow(restore.backupId)
        const agent = restore.targetAgentId
            ? await this.getAgentRow(restore.targetAgentId)
            : null
        let archivePath: string | null = null
        try {
            if (!backup || backup.status !== 'succeeded' || backup.deletedAt)
                throw new Error('backup is not available')
            if (!agent) throw new Error('target agent no longer exists')
            if (backup.userId !== agent.userId)
                throw new Error(
                    'backup owner does not match target agent owner'
                )
            const download = await this.storage.download(backup.objectKey)
            const metered = meteredStream(download.stream)
            const meteredResult = metered.result
            meteredResult.catch(() => {})
            archivePath = await this.runtime.writeRestoreArchive(
                agent,
                restore.id,
                metered.stream
            )
            const actual = await meteredResult
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
            archivePath = null
            const now = new Date()
            await this.db
                .update(agentBackupRestores)
                .set({
                    status: 'succeeded',
                    errorMessage: null,
                    completedAt: now,
                    updatedAt: now
                })
                .where(eq(agentBackupRestores.id, restore.id))
        } catch (err) {
            const message = sanitizeError(err)
            await this.db
                .update(agentBackupRestores)
                .set({
                    status: 'failed',
                    errorMessage: message,
                    completedAt: new Date(),
                    updatedAt: new Date()
                })
                .where(eq(agentBackupRestores.id, restore.id))
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
        agent: Agent
    ): Promise<AgentBackupRestoreRow> {
        const now = new Date()
        const [restore] = await this.db
            .insert(agentBackupRestores)
            .values({
                id: createObjectId('agentBackupRestore'),
                userId: agent.userId,
                backupId,
                targetAgentId: agent.id,
                status: 'running',
                mode: 'replace',
                startedAt: now,
                createdAt: now,
                updatedAt: now
            })
            .returning()
        return restore
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
                and(eq(agentBackups.id, id), ne(agentBackups.status, 'deleted'))
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
