import {
    bigint,
    index,
    integer,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agents } from './agents'

export const agentBackups = pgTable(
    'agent_backups',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        sourceAgentId: text('source_agent_id').references(() => agents.id, {
            onDelete: 'set null'
        }),
        sourceAgentName: text('source_agent_name').notNull(),
        framework: text('framework', {
            enum: [
                'openclaw',
                'hermes',
                'narranexus',
                'claude-code',
                'codex',
                'gemini-cli',
                'dify',
                'langflow',
                'a2a'
            ]
        }).notNull(),
        runtimeKind: text('runtime_kind', {
            enum: ['sprites', 'k8s', 'daemon', 'external']
        }).notNull(),
        status: text('status', {
            enum: ['running', 'succeeded', 'failed', 'deleted']
        })
            .notNull()
            .default('running'),
        objectKey: text('object_key').notNull(),
        archiveBytes: bigint('archive_bytes', { mode: 'number' })
            .notNull()
            .default(0),
        workspaceBytes: bigint('workspace_bytes', { mode: 'number' })
            .notNull()
            .default(0),
        fileCount: integer('file_count').notNull().default(0),
        sha256: text('sha256'),
        errorMessage: text('error_message'),
        startedAt: timestamp('started_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userCreatedIdx: index('agent_backups_user_created_idx').on(
            table.userId,
            table.createdAt
        ),
        sourceAgentIdx: index('agent_backups_source_agent_idx').on(
            table.sourceAgentId
        ),
        statusIdx: index('agent_backups_status_idx').on(table.status)
    })
)

export const agentBackupRestores = pgTable(
    'agent_backup_restores',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        backupId: text('backup_id')
            .notNull()
            .references(() => agentBackups.id, { onDelete: 'cascade' }),
        targetAgentId: text('target_agent_id').references(() => agents.id, {
            onDelete: 'set null'
        }),
        status: text('status', {
            enum: ['running', 'succeeded', 'failed']
        })
            .notNull()
            .default('running'),
        mode: text('mode', { enum: ['replace'] })
            .notNull()
            .default('replace'),
        errorMessage: text('error_message'),
        startedAt: timestamp('started_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        completedAt: timestamp('completed_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userCreatedIdx: index('agent_backup_restores_user_created_idx').on(
            table.userId,
            table.createdAt
        ),
        backupIdx: index('agent_backup_restores_backup_idx').on(table.backupId),
        targetAgentIdx: index('agent_backup_restores_target_agent_idx').on(
            table.targetAgentId
        )
    })
)

export type AgentBackupRow = typeof agentBackups.$inferSelect
export type NewAgentBackupRow = typeof agentBackups.$inferInsert
export type AgentBackupRestoreRow = typeof agentBackupRestores.$inferSelect
export type NewAgentBackupRestoreRow = typeof agentBackupRestores.$inferInsert
