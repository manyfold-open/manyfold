// Runs sql.js against untrusted database bytes off the main thread. A hostile
// db can embed a VIEW whose definition is an unbounded query (e.g. a recursive
// CTE behind an aggregate that defeats the LIMIT short-circuit), so every
// open/query request is terminable: the owning component kills this worker
// after PREVIEW_PARSE_TIMEOUT_MS instead of letting the page hang
// Imports are static: the iife worker bundle must stay a single chunk
import initSqlJs from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import type { Database, SqlJsStatic } from 'sql.js'
import { SQLITE_MAX_ROWS, cellText } from './previewKinds'

export interface SqliteQueryResult {
    headers: string[]
    rows: string[][]
    truncated: boolean
}

export type SqliteWorkerRequest =
    | { type: 'open'; buffer: ArrayBuffer }
    | { type: 'query'; id: number; name: string; mode: 'rows' | 'schema' }

export type SqliteWorkerResponse =
    | { type: 'opened'; objects: string[] }
    | { type: 'openError'; message: string }
    | { type: 'result'; id: number; result: SqliteQueryResult }
    | { type: 'queryError'; id: number; message: string }

let sqlJsPromise: Promise<SqlJsStatic> | null = null

const loadSqlJs = (): Promise<SqlJsStatic> => {
    if (!sqlJsPromise)
        sqlJsPromise = initSqlJs({ locateFile: () => wasmUrl })
    return sqlJsPromise
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const errorText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err)

let db: Database | null = null

const post = (message: SqliteWorkerResponse): void => {
    self.postMessage(message)
}

const runQuery = (
    request: Extract<SqliteWorkerRequest, { type: 'query' }>
): SqliteWorkerResponse => {
    if (!db)
        return {
            type: 'queryError',
            id: request.id,
            message: 'database is not open'
        }
    try {
        const sql =
            request.mode === 'schema'
                ? `PRAGMA table_info(${quoteIdent(request.name)})`
                : `SELECT * FROM ${quoteIdent(request.name)} LIMIT ${SQLITE_MAX_ROWS + 1}`
        const first = db.exec(sql)[0]
        if (!first)
            return {
                type: 'result',
                id: request.id,
                result: { headers: [], rows: [], truncated: false }
            }
        const truncated =
            request.mode === 'rows' && first.values.length > SQLITE_MAX_ROWS
        const values = truncated
            ? first.values.slice(0, SQLITE_MAX_ROWS)
            : first.values
        return {
            type: 'result',
            id: request.id,
            result: {
                headers: first.columns,
                rows: values.map((row) => row.map(cellText)),
                truncated
            }
        }
    } catch (err) {
        return { type: 'queryError', id: request.id, message: errorText(err) }
    }
}

self.onmessage = async (event: MessageEvent<SqliteWorkerRequest>) => {
    const request = event.data
    if (request.type === 'open') {
        try {
            const SQL = await loadSqlJs()
            db = new SQL.Database(new Uint8Array(request.buffer))
            const result = db.exec(
                "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
            const objects = (result[0]?.values ?? []).map((row) =>
                String(row[0])
            )
            post({ type: 'opened', objects })
        } catch (err) {
            post({ type: 'openError', message: errorText(err) })
        }
        return
    }
    post(runQuery(request))
}