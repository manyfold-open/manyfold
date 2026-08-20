import {
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'

export const userMcpServers = pgTable(
    'user_mcp_servers',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        serverKey: text('server_key').notNull(),
        name: text('name').notNull(),
        description: text('description'),
        transport: text('transport', { enum: ['http', 'stdio'] }).notNull(),
        url: text('url'),
        headers: jsonb('headers').$type<Record<string, string>>(),
        command: text('command'),
        args: jsonb('args').$type<string[]>(),
        env: jsonb('env').$type<Record<string, string>>(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userServerKeyUnique: uniqueIndex(
            'user_mcp_servers_user_server_key_unique'
        ).on(table.userId, table.serverKey)
    })
)

export type UserMcpServerRow = typeof userMcpServers.$inferSelect
export type NewUserMcpServerRow = typeof userMcpServers.$inferInsert
