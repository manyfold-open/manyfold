import type { RecoveryFs } from '../recovery-fs'

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

export const CANDIDATE_HEAD_BYTES = 65536
export const CANDIDATE_SCAN_LIMIT = 50
const MARKER = '-----MF-RECOVERY-CANDIDATE-----'
const TAIL_MARKER = '-----MF-RECOVERY-CANDIDATE-TAIL-----'

// One exec per scan instead of one full remote file read per candidate: the
// script sorts by mtime inside the sandbox (so the newest sessions are never
// cut off by the limit) and emits a tab-delimited header plus the first 64 KiB
// of each file. `read -r mt f` splits on the first whitespace run only, so
// paths containing spaces survive; a marker line cannot collide with session
// content because JSON/JSONL lines never start with the marker prefix.
//
// A file past the head window also emits its LAST 64 KiB, because a session
// list shows what happened most recently — the newest reply, when it arrived,
// and which model wrote it — and none of that is in the head of a long
// transcript. The extra window only applies where the head is not already the
// whole file, so the worst case doubles a bounded payload rather than reading
// files whole.
export const candidateScanScript = (
    findScript: string,
    limit = CANDIDATE_SCAN_LIMIT
): string =>
    [
        `${findScript} 2>/dev/null | while IFS= read -r f; do`,
        `  mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null) || continue`,
        `  printf '%s %s\\n' "$mt" "$f"`,
        `done | sort -rn | head -${limit} | while read -r mt f; do`,
        `  sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null) || continue`,
        `  ln=$(wc -l < "$f" 2>/dev/null | tr -d '[:space:]')`,
        `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' '${MARKER}' "$f" "$mt" "$sz" "$ln"`,
        `  head -c ${CANDIDATE_HEAD_BYTES} "$f"`,
        `  printf '\\n'`,
        `  if [ "$sz" -gt ${CANDIDATE_HEAD_BYTES} ]; then`,
        `    printf '%s\\t%s\\n' '${TAIL_MARKER}' "$f"`,
        `    tail -c ${CANDIDATE_HEAD_BYTES} "$f"`,
        `    printf '\\n'`,
        `  fi`,
        `done`
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

export const scanCandidateFiles = async (
    fs: RecoveryFs,
    findScript: string,
    limit = CANDIDATE_SCAN_LIMIT
): Promise<CandidateFileHead[]> => {
    const stdout = await fs.exec(candidateScanScript(findScript, limit))
    if (stdout === null) return []
    return parseCandidateScan(stdout)
}

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
