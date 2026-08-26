import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { channels } from './channels'
import { users } from './users'

export const whatsappRegistrations = pgTable(
    'whatsapp_registrations',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        agentId: text('agent_id')
            .notNull()
            .references(() => agents.id, { onDelete: 'cascade' }),
        label: text('label').notNull(),
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
        // Latest QR payload emitted by the pairing socket. Not a secret on its
        // own — it only pairs a device for whoever scans it within ~20s, and
        // reads are owner-scoped — but it is short-lived, so it is cleared as
        // soon as the registration leaves 'pending'.
        qrContent: text('qr_content'),
        // WhatsApp rotates the QR while nobody scans; the pairing socket is
        // reopened at most MAX_QR_REFRESH times before the row expires.
        refreshCount: integer('refresh_count').notNull().default(0),
        // Instance holding the in-memory pairing socket. Only that instance can
        // advance this row, so a poll served elsewhere just reports state.
        holderId: text('holder_id'),
        errorCode: text('error_code', {
            enum: [
                'access_denied',
                'already_bound',
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
        userIdx: index('whatsapp_registrations_user_idx').on(table.userId),
        expiresIdx: index('whatsapp_registrations_expires_idx').on(
            table.expiresAt
        )
    })
)

export type WhatsappRegistrationRow = typeof whatsappRegistrations.$inferSelect
export type NewWhatsappRegistrationRow =
    typeof whatsappRegistrations.$inferInsert
