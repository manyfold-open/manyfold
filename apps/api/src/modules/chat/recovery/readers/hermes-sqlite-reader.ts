import type { ChatContentBlock } from '@manyfold/shared'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '@nestjs/common'
import type { RecoveryFs } from '../recovery-fs'
import type {
    CandidateSession,
    ReaderResult,
    RecoveredMessage,
    RecoveredRawSource,
    RecoveryParentLink
} from './types'

const log = new Logger('HermesSqliteReader')
const COMPRESSION_END_REASONS = new Set(['compression', 'compressed'])
const HERMES_SQLITE_RECOVERY_PARSER_NAME = 'hermes-sqlite-history'
const HERMES_SQLITE_RECOVERY_PARSER_VERSION = '1'

interface SessionRow {
    id: string
    parent_session_id: string | null
    started_at: number | null
    ended_at: number | null
    end_reason: string | null
    title: string | null
    input_tokens: number | null
    output_tokens: number | null
    estimated_cost_usd: number | null
    actual_cost_usd: number | null
}

export interface HermesSqliteMessageRow {
    id: number
    session_id: string
    role: string
    content: string | null
    tool_call_id: string | null
    tool_calls: string | null
    tool_name: string | null
    timestamp: number | null
    reasoning: string | null
    reasoning_content: string | null
}

type MessageRow = HermesSqliteMessageRow

interface SqliteApi {
    Database: new (path: string, opts?: { readonly?: boolean }) => SqliteDb
}

interface SqliteDb {
    prepare(sql: string): SqliteStatement
    close(): void
}

interface SqliteStatement {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
}

let cachedSqlite: SqliteApi | null | undefined
const loadSqlite = async (): Promise<SqliteApi | null> => {
    if (cachedSqlite !== undefined) return cachedSqlite
    try {
        const mod = (await import('better-sqlite3')) as unknown as {
            default: SqliteApi['Database']
        }
        cachedSqlite = { Database: mod.default }
    } catch (err) {
        log.warn(
            `better-sqlite3 unavailable, falling back to JSON reader: ${(err as Error).message}`
        )
        cachedSqlite = null
    }
    return cachedSqlite
}

const resolveStateDbScript = `
profile=$(cat "$HOME/.hermes/active_profile" 2>/dev/null | tr -d '[:space:]')
if [ -n "$profile" ] && [ -f "$HOME/.hermes/profiles/$profile/state.db" ]; then
  echo "$HOME/.hermes/profiles/$profile/state.db"
elif [ -f "$HOME/.hermes/state.db" ]; then
  echo "$HOME/.hermes/state.db"
fi
`.trim()

interface StateDbFetch {
    main: Buffer | null
    wal: Buffer | null
    warnings: string[]
}

// One remote transfer per request: a view calls listCandidates and then
// readMessages on the same RecoveryFs instance, and state.db (+ WAL) can be
// tens of MB each. The handle dies with the request, so the WeakMap entry does
// too.
const stateDbFetchCache = new WeakMap<RecoveryFs, Promise<StateDbFetch>>()

const fetchStateDb = (
    fs: RecoveryFs,
    dbPath: string
): Promise<StateDbFetch> => {
    let pending = stateDbFetchCache.get(fs)
    if (!pending) {
        pending = (async (): Promise<StateDbFetch> => {
            const warnings: string[] = []
            let main: Buffer | null = null
            try {
                main = await fs.readBinary(dbPath)
            } catch (err) {
                warnings.push(
                    `failed to read ${dbPath}: ${(err as Error).message}`
                )
            }
            let wal: Buffer | null = null
            if (main) {
                try {
                    wal = await fs.readBinary(`${dbPath}-wal`)
                } catch (err) {
                    // hermes never checkpoints on its own, so recent rows live
                    // in the WAL — a dropped sidecar must be said out loud, not
                    // silently produce a shortened history.
                    warnings.push(
                        `failed to read ${dbPath}-wal (recent messages may be missing): ${(err as Error).message}`
                    )
                }
            }
            return { main, wal, warnings }
        })()
        stateDbFetchCache.set(fs, pending)
    }
    return pending
}

// hermes runs sqlite in WAL mode and never checkpoints on its own, so on a live
// agent the main state.db can be an empty 4 KiB shell with the schema AND every
// row sitting in the -wal sidecar (measured: main 4 KiB / 0 tables, -wal 1 MiB /
// 6 messages). Copying state.db alone yields a database with zero tables, so
// every hermes session read failed. Copy the sidecar alongside it; sqlite reads
// the pair fine even readonly, since the temp dir lets it build the -shm.
const materializeStateDb = async (
    fs: RecoveryFs,
    dbPath: string
): Promise<{
    tmpDir: string | null
    local: string | null
    warnings: string[]
}> => {
    const fetched = await fetchStateDb(fs, dbPath)
    if (!fetched.main)
        return { tmpDir: null, local: null, warnings: fetched.warnings }
    const tmpDir = mkdtempSync(join(tmpdir(), 'nca-hermes-'))
    const local = join(tmpDir, 'state.db')
    writeFileSync(local, fetched.main)
    if (fetched.wal && fetched.wal.length > 0)
        writeFileSync(`${local}-wal`, fetched.wal)
    return { tmpDir, local, warnings: fetched.warnings }
}

export const readHermesSqliteSession = async (
    fs: RecoveryFs,
    sessionRef: string
): Promise<ReaderResult | null> => {
    const sqlite = await loadSqlite()
    if (!sqlite) return null

    const dbPath = await fs.locate(resolveStateDbScript)
    if (!dbPath) return null

    const materialized = await materializeStateDb(fs, dbPath)
    if (!materialized.local || !materialized.tmpDir)
        return {
            sourceFile: dbPath,
            messages: [],
            warnings: materialized.warnings
        }
    const { tmpDir } = materialized

    let db: SqliteDb | null = null
    try {
        db = new sqlite.Database(materialized.local, { readonly: true })
        const target = readSessionRow(db, sessionRef)
        if (!target)
            return {
                sourceFile: dbPath,
                messages: [],
                warnings: [
                    ...materialized.warnings,
                    `hermes session ${sessionRef} not found in ${dbPath}`
                ]
            }

        const chain = walkChain(db, target)
        const messages = readChainMessages(db, chain, dbPath)
        const summary = buildSummary(chain, messages.length)
        return {
            sourceFile: dbPath,
            messages,
            warnings: materialized.warnings,
            summary
        }
    } catch (err) {
        // A torn snapshot of a live-written db surfaces as SQLITE_CORRUPT /
        // SQLITE_NOTADB from prepare; degrade to the JSON fallback instead of
        // failing the whole request.
        return {
            sourceFile: dbPath,
            messages: [],
            warnings: [
                ...materialized.warnings,
                `hermes state.db read failed: ${(err as Error).message}`
            ]
        }
    } finally {
        try {
            db?.close()
        } catch {
            // ignore
        }
        try {
            rmSync(tmpDir, { recursive: true, force: true })
        } catch {
            // ignore
        }
    }
}

export const listHermesSqliteCandidates = async (
    fs: RecoveryFs,
    limit = 50
): Promise<CandidateSession[]> => {
    const sqlite = await loadSqlite()
    if (!sqlite) return []
    const dbPath = await fs.locate(resolveStateDbScript)
    if (!dbPath) return []
    const materialized = await materializeStateDb(fs, dbPath)
    if (!materialized.local || !materialized.tmpDir) return []
    const { tmpDir } = materialized
    let db: SqliteDb | null = null
    try {
        db = new sqlite.Database(materialized.local, { readonly: true })
        const rows = db
            .prepare(
                `SELECT s.id, s.started_at, s.title,
                        (SELECT content FROM messages m
                         WHERE m.session_id = s.id AND m.role = 'user'
                         ORDER BY m.timestamp, m.id LIMIT 1) AS first_user,
                        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count
                 FROM sessions s
                 ORDER BY COALESCE(s.ended_at, s.started_at) DESC
                 LIMIT ?`
            )
            .all(limit) as Array<{
            id: string
            started_at: number | null
            title: string | null
            first_user: string | null
            msg_count: number
        }>
        return rows.map((r) => ({
            sessionRef: r.id,
            sourceFile: dbPath,
            firstUserMessage: r.first_user?.slice(0, 200) ?? r.title ?? null,
            timestamp:
                r.started_at != null
                    ? new Date(r.started_at * 1000).toISOString()
                    : null,
            messageCount: r.msg_count
        }))
    } catch (err) {
        log.warn(
            `hermes candidate listing from ${dbPath} failed: ${(err as Error).message}`
        )
        return []
    } finally {
        try {
            db?.close()
        } catch {
            // ignore
        }
        try {
            rmSync(tmpDir, { recursive: true, force: true })
        } catch {
            // ignore
        }
    }
}

const SESSION_COLS = `id, parent_session_id, started_at, ended_at, end_reason,
    title, input_tokens, output_tokens, estimated_cost_usd, actual_cost_usd`

const readSessionRow = (db: SqliteDb, id: string): SessionRow | null => {
    const row = db
        .prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`)
        .get(id) as SessionRow | undefined
    return row ?? null
}

const walkChain = (db: SqliteDb, target: SessionRow): SessionRow[] => {
    const seen = new Set<string>()
    const ancestors: SessionRow[] = []
    let cur: SessionRow | null = target
    while (cur && cur.parent_session_id) {
        if (seen.has(cur.parent_session_id)) break
        seen.add(cur.parent_session_id)
        const parent = readSessionRow(db, cur.parent_session_id)
        if (!parent) break
        ancestors.push(parent)
        cur = parent
    }
    ancestors.reverse()
    const descendants: SessionRow[] = []
    const stmt = db.prepare(
        `SELECT ${SESSION_COLS} FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC`
    )
    let frontier: string[] = [target.id]
    while (frontier.length > 0) {
        const next: string[] = []
        for (const id of frontier) {
            const children = stmt.all(id) as SessionRow[]
            for (const c of children) {
                if (seen.has(c.id)) continue
                seen.add(c.id)
                descendants.push(c)
                next.push(c.id)
            }
        }
        frontier = next
    }
    return [...ancestors, target, ...descendants]
}

const readChainMessages = (
    db: SqliteDb,
    chain: SessionRow[],
    sourceFile: string
): RecoveredMessage[] => {
    if (chain.length === 0) return []
    const placeholders = chain.map(() => '?').join(',')
    const ids = chain.map((s) => s.id)
    const rows = db
        .prepare(
            `SELECT id, session_id, role, content, tool_call_id, tool_calls,
                    tool_name, timestamp, reasoning, reasoning_content
             FROM messages
             WHERE session_id IN (${placeholders})
             ORDER BY timestamp ASC, id ASC`
        )
        .all(...ids) as MessageRow[]
    return mapRows(rows, sourceFile)
}

interface PendingAssistant {
    blocks: ChatContentBlock[]
    timestamp: string
    eventId: string
    parentExternalId: string | null
    sources: RecoveredRawSource[]
}

const mapRows = (
    rows: MessageRow[],
    sourceFile: string
): RecoveredMessage[] => {
    const out: RecoveredMessage[] = []
    let pending: PendingAssistant | null = null
    let lastUserExternalId: string | null = null
    let lastUserContent: string | null = null

    const flush = (): void => {
        if (pending && pending.blocks.length > 0) {
            out.push({
                externalId: pending.eventId,
                parentExternalId: pending.parentExternalId,
                role: 'assistant',
                contentBlocks: collapseTextBlocks(pending.blocks),
                timestamp: pending.timestamp,
                sources: pending.sources
            })
        }
        pending = null
    }

    for (const row of rows) {
        const ts = isoFromUnixSeconds(row.timestamp) ?? new Date().toISOString()
        const eventId = `hermes-sql-${row.id}`
        const source = hermesSqliteSource(
            row,
            row.id,
            row.session_id,
            sourceFile,
            eventId,
            null
        )

        if (row.role === 'user') {
            const text = row.content ?? ''
            if (!text) continue
            if (text === lastUserContent) continue
            lastUserContent = text
            flush()
            out.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'user',
                contentBlocks: [{ type: 'text', text }],
                timestamp: ts,
                sources: [source]
            })
            lastUserExternalId = eventId
            continue
        }

        if (row.role === 'assistant') {
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            const reasoning = row.reasoning_content ?? row.reasoning
            if (reasoning && reasoning.length > 0)
                pending.blocks.push({ type: 'thinking', text: reasoning })
            if (row.content && row.content.length > 0)
                pending.blocks.push({ type: 'text', text: row.content })
            const toolCalls = parseJsonArray(row.tool_calls)
            for (const tc of toolCalls) {
                const block = toToolCallBlock(tc)
                if (block) pending.blocks.push(block)
            }
            pending.sources.push({
                ...source,
                externalId: pending.eventId,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (row.role === 'tool') {
            const callId = row.tool_call_id ?? ''
            if (!callId) continue
            pending = pending ?? {
                blocks: [],
                timestamp: ts,
                eventId,
                parentExternalId: lastUserExternalId,
                sources: []
            }
            pending.blocks.push({
                type: 'tool_result',
                toolCallId: callId,
                result: row.content ?? null
            })
            pending.sources.push({
                ...source,
                externalId: pending.eventId,
                parentExternalId: lastUserExternalId
            })
            continue
        }

        if (row.role === 'system') {
            const text = row.content ?? ''
            if (!text) continue
            flush()
            out.push({
                externalId: eventId,
                parentExternalId: null,
                role: 'system',
                contentBlocks: [{ type: 'text', text }],
                timestamp: ts,
                sources: [source]
            })
            continue
        }
    }
    flush()
    return out
}

const hermesSqliteSource = (
    rawJson: MessageRow,
    sourceSeq: number,
    sourceRef: string | null | undefined,
    sourceFile: string | null | undefined,
    externalId: string,
    parentExternalId: string | null
): RecoveredRawSource => ({
    sourceRef: sourceRef ?? null,
    sourceFile: sourceFile ?? null,
    sourceSeq,
    externalId,
    parentExternalId,
    rawFormat: 'sqlite_row',
    rawJson,
    parserName: HERMES_SQLITE_RECOVERY_PARSER_NAME,
    parserVersion: HERMES_SQLITE_RECOVERY_PARSER_VERSION
})

const buildSummary = (
    chain: SessionRow[],
    messageCount: number
): {
    messageCount: number
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number | null
    parentChain: RecoveryParentLink[]
} => {
    let inputTokens = 0
    let outputTokens = 0
    let cost = 0
    let costSeen = false
    for (const s of chain) {
        inputTokens += s.input_tokens ?? 0
        outputTokens += s.output_tokens ?? 0
        const c = s.actual_cost_usd ?? s.estimated_cost_usd
        if (c != null) {
            cost += c
            costSeen = true
        }
    }
    const parentChain: RecoveryParentLink[] =
        chain.length > 1
            ? chain.slice(0, -1).map((s) => ({
                  sessionId: s.id,
                  endedAt: isoFromUnixSeconds(s.ended_at),
                  endReason:
                      s.end_reason && COMPRESSION_END_REASONS.has(s.end_reason)
                          ? 'compressed'
                          : s.end_reason
              }))
            : []
    return {
        messageCount,
        inputTokens,
        outputTokens,
        estimatedCostUsd: costSeen ? cost : null,
        parentChain
    }
}

const collapseTextBlocks = (blocks: ChatContentBlock[]): ChatContentBlock[] => {
    const out: ChatContentBlock[] = []
    let buffer = ''
    const flush = (): void => {
        if (buffer) {
            out.push({ type: 'text', text: buffer })
            buffer = ''
        }
    }
    for (const block of blocks) {
        if (block.type === 'text') buffer += block.text
        else {
            flush()
            out.push(block)
        }
    }
    flush()
    return out
}

const parseJsonArray = (raw: string | null): unknown[] => {
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

const toToolCallBlock = (raw: unknown): ChatContentBlock | null => {
    if (typeof raw !== 'object' || raw === null) return null
    const r = raw as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : null
    const fn =
        typeof r.function === 'object' && r.function !== null
            ? (r.function as Record<string, unknown>)
            : null
    const name = fn && typeof fn.name === 'string' ? fn.name : null
    if (!id || !name) return null
    let args: unknown = fn?.arguments ?? null
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args)
        } catch {
            // keep string
        }
    }
    return { type: 'tool_call', toolCallId: id, toolName: name, args }
}

const isoFromUnixSeconds = (v: number | null | undefined): string | null => {
    if (v == null || !Number.isFinite(v)) return null
    return new Date(v * 1000).toISOString()
}
