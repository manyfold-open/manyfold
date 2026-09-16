import Module from 'node:module'
import { databaseGuard, databaseModule } from './test-db-policy.mjs'

const mode = process.env.MF_TEST_DB_MODE
if (typeof Module.register !== 'function')
    throw new Error(
        'sealed test guards require Node >=20.6; refusing to run without the ESM database sentinel'
    )
if (!['allow', 'deny'].includes(mode) || !process.env.MF_TEST_DB_LOG)
    throw new Error('test DB guard requires a sealed runner policy and log')

const entry = process.argv[1] ?? ''
const pgEntry = /\.pg\.test\.[cm]?[jt]sx?$/.test(entry)
const testEntry = /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry)
const launcher =
    process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT
let allowDatabase =
    mode === 'allow' && (pgEntry || process.env.MF_TEST_PG_PARENT === '1')
if (!launcher && testEntry && !pgEntry) {
    allowDatabase = false
    process.env.MF_TEST_DB_MODE = 'deny'
    delete process.env.MF_TEST_PG_PARENT
} else if (!launcher && pgEntry && allowDatabase)
    process.env.MF_TEST_PG_PARENT = '1'

export const wrapDatabaseModule = databaseGuard({
    allowDatabase,
    dotenvPath: process.env.DOTENV_CONFIG_PATH,
    logFile: process.env.MF_TEST_DB_LOG
})

// module.register covers ESM. Node 20's legacy require loader does not go
// through those hooks, including tsx's CommonJS transform, so it needs this
// narrow bridge. Both paths share the same proxies and violation ledger.
const load = Module._load
Module._load = function (request, parent, ...rest) {
    const result = load.call(this, request, parent, ...rest)
    const kind = databaseModule(Module._resolveFilename(request, parent))
    return kind ? wrapDatabaseModule(result, kind) : result
}
Module.register(new URL('./test-db-loader.mjs', import.meta.url), {
    parentURL: import.meta.url,
    data: { guardUrl: import.meta.url }
})
