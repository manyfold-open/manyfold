import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { channels } from './channels'

export const channelProviderStates = pgTable('channel_provider_states', {
    channelId: text('channel_id')
        .primaryKey()
        .references(() => channels.id, { onDelete: 'cascade' }),
    stateJson: jsonb('state_json').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type ChannelProviderStateRow = typeof channelProviderStates.$inferSelect
export type NewChannelProviderStateRow =
    typeof channelProviderStates.$inferInsert
