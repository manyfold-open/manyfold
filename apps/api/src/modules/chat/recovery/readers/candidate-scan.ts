import type { RecoveryFs } from '../recovery-fs'
import type { CandidateScanCache } from './candidate-scan-cache'
import type { CandidateListing, CandidateSession } from './types'

export interface CandidateFileHead {
    path: string
    mtimeMs: number
    size: number
    lineCount: number
    headText: string
    // Only for files larger than the head window; null means headText already
    // holds the whole file.
    tailText: string | null
    truncated: boolean
}

// One transcript as the index sees it: enough to sort, to page, and to tell
// whether a cached summary of it is still current.
export interface CandidateIndexEntry {
    path: string
    mtimeMs: number
    size: number
}

export const CANDIDATE_HEAD_BYTES = 65536
export const CANDIDATE_SCAN_LIMIT = 50
// Files read per fetch exec. Each one ships up to two 64 KiB windows, so a
// cold page is bounded here whatever `limit` the caller asked for; the
// response reports how much of the page it actually covered.
export const CANDIDATE_FETCH_LIMIT = 50
const MARKER = '-----MF-RECOVERY-CANDIDATE-----'
const TAIL_MARKER = '-----MF-RECOVERY-CANDIDATE-TAIL-----'
const FETCH_LIST_END = 'MF_CANDIDATES'

// GNU stat takes -c, BSD stat takes -f; probe once per script instead of
// trying both per file.
const statProbe = (gnuSpec: string, bsdSpec: string): string =>
    `if stat -c %Y . >/dev/null 2>&1; then fmt=-c; spec='${gnuSpec}'; else fmt=-f; spec='${bsdSpec}'; fi`

// The scan is two execs. This one lists EVERY transcript as `mtime size path`,
// newest first, with a single stat invocation for the whole tree.
//
// Measured on macOS dev [2026-09-04]: 943 transcripts. The previous script
// ran `$(stat …)` once per file inside a shell loop and spent 3.2 s of its
// 4.2 s forking; the same index through `xargs -0 stat` takes 0.03 s and
// 58 KB of output. Paths containing spaces survive because the parser takes
// everything after the second field as the path.
export const candidateIndexScript = (findScript: string): string =>
    [
        statProbe('%Y %s %n', '%m %z %N'),
        `${findScript} 2>/dev/null | tr '\\n' '\\0' | xargs -0 stat "$fmt" "$spec" 2>/dev/null | sort -rn`
    ].join('\n')

export const parseCandidateIndex = (stdout: string): CandidateIndexEntry[] => {
    const out: CandidateIndexEntry[] = []
    for (const line of stdout.split('\n')) {
        const match = line.match(/^(\d+) (\d+) (.+)$/)
        if (!match) continue
        out.push({
            path: match[3],
            mtimeMs: Number.parseInt(match[1], 10) * 1000,
            size: Number.parseInt(match[2], 10)
        })
    }
    return out
}

// The second exec: a tab-delimited header plus the first 64 KiB of each
// listed file, and for a file past the head window also its LAST 64 KiB,
// because a session list shows what happened most recently — the newest
// reply, when it arrived, and which model wrote it — and none of that is in
// the head of a long transcript. A marker line cannot collide with session
// content because JSON/JSONL lines never start with the marker prefix.
//
// The paths ride in a quoted heredoc (no expansion; they come from the
// runtime's own find, not from a user), and each file is stat'ed again so the
// header's mtime/size — the cache key — describes the bytes actually read,
// not the index taken a moment earlier.
export const candidateFetchScript = (paths: string[]): string =>
    [
        statProbe('%Y %s', '%m %z'),
        `while IFS= read -r f; do`,
        `  st=$(stat "$fmt" "$spec" "$f" 2>/dev/null) || continue`,
        `  set -- $st; mt=$1; sz=$2`,
        `  ln=$(wc -l < "$f" 2>/dev/null | tr -d '[:space:]')`,
        `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' '${MARKER}' "$f" "$mt" "$sz" "$ln"`,
        `  head -c ${CANDIDATE_HEAD_BYTES} "$f"`,
        `  printf '\\n'`,
        `  if [ "$sz" -gt ${CANDIDATE_HEAD_BYTES} ]; then`,
        `    printf '%s\\t%s\\n' '${TAIL_MARKER}' "$f"`,
        `    tail -c ${CANDIDATE_HEAD_BYTES} "$f"`,
        `    printf '\\n'`,
        `  fi`,
        `done <<'${FETCH_LIST_END}'`,
        // A heredoc line is one path; anything that is not an absolute
        // single-line path could not have come from find anyway.
        ...paths.filter((path) => path.startsWith('/') && !path.includes('\n')),
        FETCH_LIST_END
    ].join('\n')

export const parseCandidateScan = (stdout: string): CandidateFileHead[] => {
    const out: CandidateFileHead[] = []
    let current: CandidateFileHead | null = null
    let lines: string[] = []
    let inTail = false
    const flushSection = (): void => {
        if (!current) return
        if (inTail) current.tailText = lines.join('\n')
        else current.headText = lines.join('\n')
        lines = []
    }
    const flush = (): void => {
        if (!current) return
        flushSection()
        out.push(current)
        current = null
        inTail = false
    }
    for (const line of stdout.split('\n')) {
        if (line.startsWith(`${MARKER}\t`)) {
            flush()
            const parts = line.split('\t')
            const path = parts[1] ?? ''
            if (!path) continue
            const mtime = Number.parseInt(parts[2] ?? '', 10)
            const size = Number.parseInt(parts[3] ?? '', 10)
            const lineCount = Number.parseInt(parts[4] ?? '', 10)
            current = {
                path,
                mtimeMs: Number.isFinite(mtime) ? mtime * 1000 : 0,
                size: Number.isFinite(size) ? size : 0,
                lineCount: Number.isFinite(lineCount) ? lineCount : 0,
                headText: '',
                tailText: null,
                truncated: Number.isFinite(size) && size > CANDIDATE_HEAD_BYTES
            }
            continue
        }
        if (line.startsWith(`${TAIL_MARKER}\t`)) {
            if (!current) continue
            flushSection()
            inTail = true
            continue
        }
        if (current) lines.push(line)
    }
    flush()
    return out
}

export interface CandidateScanOptions<T extends { sessionRef: string }> {
    agentId: string
    // How many of the newest transcripts the caller wants summarized.
    limit: number
    cache?: CandidateScanCache
    // One transcript's windows to a list row; null when the file carries no
    // session id (a negative that is cached too, so junk is not re-read).
    summarize: (head: CandidateFileHead) => T | null
    // The session id a filename alone proves, for readers whose CLI names the
    // transcript after it. Lets the cloud side of the list mark presence on
    // the runtime beyond the summarized page without reading anything.
    refFromPath?: (path: string) => string | null
}

export interface CandidateScanResult<T> {
    // Newest first; only the transcripts the scan covered.
    candidates: T[]
    // Every transcript the index found, before the limit.
    total: number
    // How many of the newest `limit` entries `candidates` accounts for. Less
    // than min(limit, total) means the fetch cap cut the page short and the
    // same call again would cover more.
    listed: number
    filesByRef: Map<string, CandidateIndexEntry>
}

// Index everything, then read only what the cache does not already describe:
// a transcript whose mtime and size are unchanged since it was last
// summarized yields the same row, and the live session's file is usually the
// only one that moved between two opens of the panel.
export const scanCandidates = async <T extends { sessionRef: string }>(
    fs: RecoveryFs,
    findScript: string,
    opts: CandidateScanOptions<T>
): Promise<CandidateScanResult<T>> => {
    const index = parseCandidateIndex(
        (await fs.exec(candidateIndexScript(findScript))) ?? ''
    )
    const page = index.slice(0, Math.max(0, opts.limit))
    const cached =
        opts.cache?.lookup<T>(opts.agentId, page) ?? new Map<string, T | null>()
    const misses = page
        .filter((entry) => !cached.has(entry.path))
        .slice(0, CANDIDATE_FETCH_LIMIT)
    const fetched = new Map<string, T | null>()
    if (misses.length > 0) {
        const heads = parseCandidateScan(
            (await fs.exec(
                candidateFetchScript(misses.map((entry) => entry.path))
            )) ?? ''
        )
        const values = heads.map((head) => opts.summarize(head))
        heads.forEach((head, i) => fetched.set(head.path, values[i]))
        opts.cache?.store(opts.agentId, heads, values)
    }
    opts.cache?.retain(opts.agentId, index)

    const valueOf = (path: string): T | null | undefined =>
        cached.has(path) ? cached.get(path) : fetched.get(path)
    const candidates: T[] = []
    let listed = 0
    for (const entry of page) {
        const value = valueOf(entry.path)
        // Past the fetch cap, or gone between the two execs.
        if (value === undefined) continue
        listed++
        if (value !== null) candidates.push(value)
    }

    const filesByRef = new Map<string, CandidateIndexEntry>()
    if (opts.refFromPath)
        for (const entry of index) {
            const ref = opts.refFromPath(entry.path)
            if (ref) filesByRef.set(ref, entry)
        }
    // What a transcript says about itself beats what its filename suggests.
    for (const entry of page) {
        const value = valueOf(entry.path)
        if (value) filesByRef.set(value.sessionRef, entry)
    }
    return { candidates, total: index.length, listed, filesByRef }
}

// For the readers that get their list from somewhere other than the file
// scan (a database, an RPC): the whole set is the page.
export const candidateListing = (
    candidates: CandidateSession[]
): CandidateListing => ({
    candidates,
    total: candidates.length,
    listed: candidates.length,
    filesByRef: new Map()
})

export const mtimeIso = (head: CandidateFileHead): string | null =>
    head.mtimeMs > 0 ? new Date(head.mtimeMs).toISOString() : null

// The lines a line-oriented summary may read backwards from. A tail window
// starts mid-file, so its first line is a fragment of whatever record straddled
// the cut and is dropped; when there is no tail the head IS the whole file.
export const candidateTailLines = (head: CandidateFileHead): string[] => {
    if (head.tailText === null) return head.headText.split('\n')
    const lines = head.tailText.split('\n')
    return lines.slice(1)
}

// One line of prose for a list row: transcripts wrap, indent and embed blank
// lines, none of which survive a two-line clamp legibly.
export const candidateExcerpt = (text: string | null): string | null => {
    if (!text) return null
    const collapsed = text.replace(/\s+/g, ' ').trim()
    if (!collapsed) return null
    return collapsed.slice(0, 200)
}

// Best-effort key extraction for whole-file JSON formats whose 64 KiB head no
// longer parses once truncated.
export const jsonStringField = (text: string, key: string): string | null => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
    return match ? match[1] : null
}
