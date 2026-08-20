import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { channels } from './channels'

export const channelLeases = pgTable('channel_leases', {
    channelId: text('channel_id')
        .primaryKey()
        .references(() => channels.id, { onDelete: 'cascade' }),
    holderId: text('holder_id').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type ChannelLeaseRow = typeof channelLeases.$inferSelect
export type NewChannelLeaseRow = typeof channelLeases.$inferInsert
