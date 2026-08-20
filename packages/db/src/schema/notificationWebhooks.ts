import {
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp
} from 'drizzle-orm/pg-core'

export const notificationWebhooks = pgTable(
    'notification_webhooks',
    {
        id: text('id').primaryKey(),
        provider: text('provider', {
            enum: ['slack', 'discord', 'lark', 'telegram']
        }).notNull(),
        label: text('label').notNull(),
        enabled: boolean('enabled').notNull().default(true),
        events: jsonb('events').notNull().$type<string[]>(),
        configCiphertext: text('config_ciphertext').notNull(),
        keyVersion: integer('key_version').notNull().default(1),
        lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
        lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
        lastErrorMessage: text('last_error_message'),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        enabledIdx: index('notification_webhooks_enabled_idx').on(table.enabled)
    })
)

export type NotificationWebhookRow = typeof notificationWebhooks.$inferSelect
export type NewNotificationWebhookRow = typeof notificationWebhooks.$inferInsert