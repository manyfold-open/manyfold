import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agentRuntimes } from './agentRuntimes'

export const agentCredentials = pgTable('agent_credentials', {
    id: text('id').primaryKey(),
    runtimeId: text('runtime_id')
        .notNull()
        .unique()
        .references(() => agentRuntimes.id, { onDelete: 'cascade' }),
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
    payloadCiphertext: text('payload_ciphertext').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type AgentCredential = typeof agentCredentials.$inferSelect
export type NewAgentCredential = typeof agentCredentials.$inferInsert
