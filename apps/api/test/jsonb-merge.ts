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
