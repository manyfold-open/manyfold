import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const k8sClusters = pgTable('k8s_clusters', {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    description: text('description'),
    kubeconfigCiphertext: text('kubeconfig_ciphertext').notNull(),
    kubeconfigKeyVersion: integer('kubeconfig_key_version')
        .notNull()
        .default(1),
    hostSuffix: text('host_suffix'),
    region: text('region'),
    lastHealthStatus: text('last_health_status', {
        enum: ['unknown', 'ok', 'failed']
    })
        .notNull()
        .default('unknown'),
    lastHealthMessage: text('last_health_message'),
    lastHealthCheckedAt: timestamp('last_health_checked_at', {
        withTimezone: true
    }),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
})

export type K8sCluster = typeof k8sClusters.$inferSelect
export type NewK8sCluster = typeof k8sClusters.$inferInsert
