import { sql, type SQL } from 'drizzle-orm'
import { type AnyPgColumn } from 'drizzle-orm/pg-core'

export const jsonbMerge = (
    column: AnyPgColumn,
    patch: Record<string, unknown>
): SQL =>
    sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`

// jsonbMerge, and `nested` merged one level deeper into the object at `key`:
// what `nested` leaves out keeps its value there, in the live row rather than
// a snapshot read before. A value at `key` that is not an object counts as
// empty, since `||` with one would build an array.
export const jsonbMergeNested = (
    column: AnyPgColumn,
    patch: Record<string, unknown>,
    key: string,
    nested: Record<string, unknown>
): SQL =>
    sql`${jsonbMerge(column, patch)} || jsonb_build_object(${key}::text, (case when jsonb_typeof(${column} -> ${key}::text) = 'object' then ${column} -> ${key}::text else '{}'::jsonb end) || ${JSON.stringify(nested)}::jsonb)`
