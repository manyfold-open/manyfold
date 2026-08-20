import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { channels } from './channels'
import { users } from './users'

export const larkAppRegistrations = pgTable(
    'lark_app_registrations',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        label: text('label').notNull(),
        botName: text('bot_name').notNull(),
        appRegion: text('app_region', { enum: ['feishu', 'lark'] }).notNull(),
        pollRegion: text('poll_region', { enum: ['feishu', 'lark'] }).notNull(),
        status: text('status', {
            enum: [
                'pending',
                'creating',
                'succeeded',
                'failed',
                'expired',
                'cancelled'
            ]
        })
            .notNull()
            .default('pending'),
        deviceCodeCiphertext: text('device_code_ciphertext').notNull(),
        keyVersion: integer('key_version').notNull().default(1),
        qrUrl: text('qr_url').notNull(),
        userCode: text('user_code').notNull(),
        intervalSec: integer('interval_sec').notNull().default(5),
        lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
        errorCode: text('error_code', {
            enum: [
                'access_denied',
                'upstream_error',
                'channel_create_failed'
            ]
        }),
        errorMessage: text('error_message'),
        channelId: text('channel_id').references(() => channels.id, {
            onDelete: 'set null'
        }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userStatusIdx: index('lark_app_registrations_user_status_idx').on(
            table.userId,
            table.status
        ),
        statusExpiresIdx: index(
            'lark_app_registrations_status_expires_idx'
        ).on(table.status, table.expiresAt)
    })
)

export type LarkAppRegistrationRow = typeof larkAppRegistrations.$inferSelect
export type NewLarkAppRegistrationRow = typeof larkAppRegistrations.$inferInsert
