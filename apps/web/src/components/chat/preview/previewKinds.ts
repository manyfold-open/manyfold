export const MAX_DOCX_PREVIEW_BYTES = 10_000_000
export const MAX_XLSX_PREVIEW_BYTES = 10_000_000
export const MAX_SQLITE_PREVIEW_BYTES = 20_000_000
export const MAX_HIGHLIGHT_BYTES = 262_144
export const CSV_MAX_RENDER_ROWS = 500
export const CSV_MAX_RENDER_COLS = 200
export const SHEET_MAX_ROWS = 200
export const SHEET_MAX_COLS = 50
export const SQLITE_MAX_ROWS = 200
// The on-disk caps above measure COMPRESSED bytes; docx/xlsx are DEFLATE zips
// that can inflate ~1000:1, so the declared inflated size is gated separately
export const MAX_ZIP_INFLATED_BYTES = 100_000_000
// Untrusted files parse in dedicated workers; terminate any request that
// exceeds this budget so a hostile file can never hang the page
export const PREVIEW_PARSE_TIMEOUT_MS = 20_000
// Never add allow-same-origin: srcDoc + opaque origin keeps frame scripts away
// from the parent DOM, storage and the auth session (locked by previewKinds.test.ts)
export const HTML_PREVIEW_SANDBOX = 'allow-scripts'

export type BinaryPreviewKind = 'docx' | 'xlsx' | 'sqlite'

export const binaryPreviewKind = (ext: string): BinaryPreviewKind | null => {
    if (ext === 'docx') return 'docx'
    if (ext === 'xlsx') return 'xlsx'
    if (ext === 'sqlite' || ext === 'sqlite3' || ext === 'db') return 'sqlite'
    return null
}

export const binaryPreviewLimit = (kind: BinaryPreviewKind): number => {
    if (kind === 'docx') return MAX_DOCX_PREVIEW_BYTES
    if (kind === 'xlsx') return MAX_XLSX_PREVIEW_BYTES
    return MAX_SQLITE_PREVIEW_BYTES
}

export const isLegacyExcelExt = (ext: string): boolean => ext === 'xls'

export const isHtmlExt = (ext: string): boolean =>
    ext === 'html' || ext === 'htm'

const CODE_LANGUAGES: Record<string, string> = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    dockerfile: 'dockerfile',
    go: 'go',
    h: 'c',
    js: 'javascript',
    json: 'json',
    jsonl: 'json',
    jsx: 'javascript',
    mjs: 'javascript',
    ndjson: 'json',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'bash',
    sql: 'sql',
    toml: 'ini',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'bash'
}

export const codeLanguageFor = (ext: string): string | null =>
    CODE_LANGUAGES[ext] ?? null

export const cellText = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Uint8Array) return `[blob ${value.length} B]`
    if (typeof value === 'object') {
        const cell = value as Record<string, unknown>
        if (Array.isArray(cell.richText))
            return cell.richText
                .map((part) =>
                    cellText((part as Record<string, unknown> | null)?.text)
                )
                .join('')
        if ('formula' in cell) return cellText(cell.result)
        if ('hyperlink' in cell) return cellText(cell.text)
        if ('error' in cell) return '#ERR'
        if ('text' in cell) return cellText(cell.text)
    }
    return String(value)
}