import type { RecoveryFs } from '../recovery-fs'

export interface CandidateFileHead {
    path: string
    mtimeMs: number
    size: number
    lineCount: number
    headText: string
    truncated: boolean
}

export const CANDIDATE_HEAD_BYTES = 65536
export const CANDIDATE_SCAN_LIMIT = 50
const MARKER = '-----MF-RECOVERY-CANDIDATE-----'

// One exec per scan instead of one full remote file read per candidate: the
// script sorts by mtime inside the sandbox (so the newest sessions are never
// cut off by the limit) and emits a tab-delimited header plus the first 64 KiB
// of each file. `read -r mt f` splits on the first whitespace run only, so
// paths containing spaces survive; a marker line cannot collide with session
// content because JSON/JSONL lines never start with the marker prefix.
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
        `done`
    ].join('\n')

export const parseCandidateScan = (stdout: string): CandidateFileHead[] => {
    const out: CandidateFileHead[] = []
    let current: CandidateFileHead | null = null
    let headLines: string[] = []
    const flush = (): void => {
        if (!current) return
        current.headText = headLines.join('\n')
        out.push(current)
        current = null
        headLines = []
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
                truncated: Number.isFinite(size) && size > CANDIDATE_HEAD_BYTES
            }
            continue
        }
        if (current) headLines.push(line)
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

// Best-effort key extraction for whole-file JSON formats whose 64 KiB head no
// longer parses once truncated.
export const jsonStringField = (text: string, key: string): string | null => {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))
    return match ? match[1] : null
}
