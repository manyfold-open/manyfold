import { is, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const dialect = new PgDialect()

export const readJsonbMergePatch = (
    value: unknown
): Record<string, unknown> | undefined => {
    if (!is(value, SQL)) return undefined

    const query = dialect.sqlToQuery(value)
    if (
        !/^coalesce\(.+, '\{\}'::jsonb\) \|\| \$1::jsonb$/.test(query.sql) ||
        query.params.length !== 1 ||
        typeof query.params[0] !== 'string'
    )
        return undefined

    const patch: unknown = JSON.parse(query.params[0])
    return typeof patch === 'object' && patch !== null && !Array.isArray(patch)
        ? (patch as Record<string, unknown>)
        : undefined
}

// The outer patch, the key and the patch merged under it, of a
// jsonbMergeNested write.
export const readJsonbMergeNestedPatch = (
    value: unknown
):
    | {
          patch: Record<string, unknown>
          key: string
          nested: Record<string, unknown>
      }
    | undefined => {
    if (!is(value, SQL)) return undefined
    const query = dialect.sqlToQuery(value)
    const [patch, key, , , nested] = query.params
    if (
        !/^coalesce\(.+, '\{\}'::jsonb\) \|\| \$1::jsonb \|\| jsonb_build_object\(\$2::text, /.test(
            query.sql
        ) ||
        query.params.length !== 5 ||
        typeof patch !== 'string' ||
        typeof key !== 'string' ||
        typeof nested !== 'string'
    )
        return undefined
    return {
        patch: JSON.parse(patch) as Record<string, unknown>,
        key,
        nested: JSON.parse(nested) as Record<string, unknown>
    }
}
