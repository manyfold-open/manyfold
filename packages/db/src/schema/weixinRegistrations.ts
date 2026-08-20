import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { agents } from './agents'
import { channels } from './channels'
import { users } from './users'

export const weixinRegistrations = pgTable(
    'weixin_registrations',
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
                'need_verify_code',
                'creating',
                'succeeded',
                'failed',
                'expired',
                'cancelled'
            ]
        })
            .notNull()
            .default('pending'),
        // The iLink QR handle used to poll scan status; server-side secret,
        // encrypted at rest like the Lark device code.
        qrcodeCiphertext: text('qrcode_ciphertext').notNull(),
        keyVersion: integer('key_version').notNull().default(1),
        // The scannable URL shown to the user (not secret).
        qrcodeContent: text('qrcode_content').notNull(),
        // Effective polling host; may switch to an IDC-specific host mid-scan.
        pollBaseUrl: text('poll_base_url').notNull(),
        // Pairing code the user typed on the web UI, held until the next poll
        // carries it upstream; encrypted and cleared after each attempt.
        verifyCodeCiphertext: text('verify_code_ciphertext'),
        verifyKeyVersion: integer('verify_key_version'),
        refreshCount: integer('refresh_count').notNull().default(0),
        lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
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
        userStatusIdx: index('weixin_registrations_user_status_idx').on(
            table.userId,
            table.status
        ),
        statusExpiresIdx: index('weixin_registrations_status_expires_idx').on(
            table.status,
            table.expiresAt
        )
    })
)

export type WeixinRegistrationRow = typeof weixinRegistrations.$inferSelect
export type NewWeixinRegistrationRow = typeof weixinRegistrations.$inferInsert
