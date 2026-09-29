import { sql } from 'drizzle-orm'
import {
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'

// One agent create in flight, and its outcome for a day after. It holds the
// name the create will insert — the agent row itself only appears near the
// end, once there is a runtime to hang it on — lets a repeat of the same
// request attach to the running create instead of building a second sandbox,
// and carries the heartbeat that tells a live create from one whose API
// process died.
export const agentCreateRequests = pgTable(
    'agent_create_requests',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        actorUserId: text('actor_user_id').notNull(),
        name: text('name').notNull(),
        // A hash of what the request asked for: the same name with the same
        // fingerprint is the same create.
        fingerprint: text('fingerprint').notNull(),
        status: text('status', {
            enum: ['in_progress', 'succeeded', 'failed']
        })
            .notNull()
            .default('in_progress'),
        step: text('step'),
        hostId: text('host_id'),
        runtimeId: text('runtime_id'),
        agentId: text('agent_id'),
        // The API error the create ended with: code, status, message, details.
        error: jsonb('error'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        inProgressNameUnique: uniqueIndex(
            'agent_create_requests_in_progress_name_uq'
        )
            .on(table.userId, table.name)
            .where(sql`${table.status} = 'in_progress'`),
        userUpdatedIdx: index('agent_create_requests_user_updated_idx').on(
            table.userId,
            table.updatedAt
        )
    })
)

export type AgentCreateRequestRow = typeof agentCreateRequests.$inferSelect
