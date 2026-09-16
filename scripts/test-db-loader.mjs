import { fileURLToPath } from 'node:url'
import { databaseModule } from './test-db-policy.mjs'

let guardUrl
export function initialize(data) {
    guardUrl = data.guardUrl
}

export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('mf-test-db-original:'))
        return {
            url:
                decodeURIComponent(
                    specifier.slice('mf-test-db-original:'.length)
                ) + '?mf_test_db_original',
            shortCircuit: true
        }
    const resolved = await nextResolve(specifier, context)
    if (
        !resolved.url.startsWith('file:') ||
        resolved.url.includes('?mf_test_db_original')
    )
        return resolved
    const kind = databaseModule(fileURLToPath(resolved.url))
    if (!kind) return resolved
    const original = JSON.stringify(
        `mf-test-db-original:${encodeURIComponent(resolved.url)}`
    )
    const named =
        kind === 'pg'
            ? 'export const Client = guarded.Client; export const Pool = guarded.Pool;'
            : kind === 'dotenv'
              ? 'export const config = guarded.config; export const configDotenv = guarded.configDotenv;'
              : ''
    const source = `import * as original from ${original}; import { wrapDatabaseModule } from ${JSON.stringify(guardUrl)}; const guarded = wrapDatabaseModule(original.default, ${JSON.stringify(kind)}); export default guarded; export * from ${original}; ${named}`
    return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true
    }
}

export async function load(url, context, nextLoad) {
    if (url.endsWith('?mf_test_db_original'))
        return nextLoad(url.slice(0, -'?mf_test_db_original'.length), context)
    return nextLoad(url, context)
}
