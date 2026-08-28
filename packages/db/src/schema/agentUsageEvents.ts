import {
    foreignKey,
    index,
    integer,
    numeric,
    pgTable,
    text,
    timestamp,
    boolean,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { userModelProviders } from './userModelProviders'

export const agentUsageEvents = pgTable(
    'agent_usage_events',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id'),
        runtimeId: text('runtime_id'),
        sessionId: text('session_id'),
        messageId: text('message_id'),
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
        model: text('model'),
        inputTokens: integer('input_tokens').notNull().default(0),
        outputTokens: integer('output_tokens').notNull().default(0),
        cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
        cacheCreationTokens: integer('cache_creation_tokens')
            .notNull()
            .default(0),
        costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
        costSource: text('cost_source', {
            enum: ['upstream', 'table', 'unknown']
        }).notNull(),
        isFallbackModel: boolean('is_fallback_model').notNull().default(false),
        firstTokenMs: integer('first_token_ms'),
        totalMs: integer('total_ms'),
        modelProviderId: text('model_provider_id'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userCreatedIdx: index('agent_usage_events_user_created_idx').on(
            table.userId,
            table.createdAt
        ),
        runtimeCreatedIdx: index('agent_usage_events_runtime_created_idx').on(
            table.runtimeId,
            table.createdAt
        ),
        agentCreatedIdx: index('agent_usage_events_agent_created_idx').on(
            table.agentId,
            table.createdAt
        ),
        sessionIdx: index('agent_usage_events_session_idx').on(table.sessionId),
        modelProviderIdx: index('agent_usage_events_model_provider_idx').on(
            table.modelProviderId,
            table.createdAt
        ),
        messageUnique: uniqueIndex('agent_usage_events_message_unique').on(
            table.messageId
        ),
        // Historical hand-written FK, declared under its legacy name: deployed
        // databases hold the constraint under that name (it predates
        // drizzle-managed constraints on this table), and renaming buys
        // nothing but schema/DB drift.
        modelProviderFk: foreignKey({
            columns: [table.modelProviderId],
            foreignColumns: [userModelProviders.id],
            name: 'agent_usage_events_model_provider_id_fkey'
        }).onDelete('set null')
    })
)

export type AgentUsageEventRow = typeof agentUsageEvents.$inferSelect
export type NewAgentUsageEventRow = typeof agentUsageEvents.$inferInsert
