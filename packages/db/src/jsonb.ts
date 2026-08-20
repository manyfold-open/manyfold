import { sql, type SQL } from 'drizzle-orm'
import { type AnyPgColumn } from 'drizzle-orm/pg-core'

export const jsonbMerge = (
    column: AnyPgColumn,
    patch: Record<string, unknown>
): SQL =>
    sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`
