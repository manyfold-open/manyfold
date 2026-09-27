import {
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'

// One Admin-registered source of hosted capacity (ADR-0037): a sprites.dev
// organisation, a Kubernetes cluster, or whatever provider comes next. The
// shared columns are what placement and the Admin list read; everything a
// provider needs beyond them lives in `config`, whose shape only that
// provider's adapter knows. Credentials keep the existing encryption envelope
// (ciphertext + key version) and never enter `config`.
export type RuntimeProviderKind = 'sprites' | 'k8s'

export interface SpritesProviderConfig {
    orgSlug: string
    orgId: string
    tokenId: string
    notes?: string | null
}

export interface K8sProviderConfig {
    description?: string | null
    hostSuffix?: string | null
}

export type RuntimeProviderConfig = SpritesProviderConfig | K8sProviderConfig

export const runtimeProviders = pgTable('runtime_providers', {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['sprites', 'k8s'] })
        .notNull()
        .$type<RuntimeProviderKind>(),
    // Unique per kind: the Admin-facing handle (a sprites org slug, a cluster
    // name). Two kinds may reuse a name.
    name: text('name').notNull(),
    status: text('status', { enum: ['enabled', 'disabled'] })
        .notNull()
        .default('enabled'),
    // Placement preference; higher first.
    priority: integer('priority').notNull().default(0),
    region: text('region'),
    credentialCiphertext: text('credential_ciphertext').notNull(),
    credentialKeyVersion: integer('credential_key_version')
        .notNull()
        .default(1),
    config: jsonb('config').$type<RuntimeProviderConfig>().notNull().default({} as RuntimeProviderConfig),
    lastHealthStatus: text('last_health_status', {
        enum: ['unknown', 'ok', 'failed']
    })
        .notNull()
        .default('unknown'),
    lastHealthMessage: text('last_health_message'),
    lastHealthCheckedAt: timestamp('last_health_checked_at', {
        withTimezone: true
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
        .notNull()
        .defaultNow()
}, (table) => ({
    kindNameUnique: uniqueIndex('runtime_providers_kind_name_unique').on(
        table.kind,
        table.name
    )
}))

export type RuntimeProvider = typeof runtimeProviders.$inferSelect
export type NewRuntimeProvider = typeof runtimeProviders.$inferInsert
