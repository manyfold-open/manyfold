import { assertPublicHttpUrl } from '@manyfold/external-providers'

export interface FileInput {
    // `data` → a base64 data: URL; `url` → a remote http(s) URL we fetch.
    kind: 'data' | 'url'
    value: string
    contentType?: string
    filename?: string
}

export interface ResolvedFile {
    name: string
    contentType: string
    bytes: Buffer
}

const FETCH_TIMEOUT_MS = 15_000

export const resolveFileInput = async (
    input: FileInput,
    maxBytes: number
): Promise<ResolvedFile> =>
    input.kind === 'data'
        ? parseDataUrl(input.value, input.filename, maxBytes)
        : fetchRemoteFile(
              input.value,
              input.contentType,
              input.filename,
              maxBytes
          )

const parseDataUrl = (
    raw: string,
    filename: string | undefined,
    maxBytes: number
): ResolvedFile => {
    const trimmed = raw.trim()
    const comma = trimmed.indexOf(',')
    if (!trimmed.startsWith('data:') || comma === -1)
        throw new FileSourceError('file content must be a data: URL')
    const header = trimmed.slice('data:'.length, comma)
    if (!/;base64$/i.test(header))
        throw new FileSourceError('file data URL must be base64-encoded')
    const contentType =
        header.replace(/;base64$/i, '').split(';')[0]?.trim() ||
        'application/octet-stream'
    const bytes = Buffer.from(trimmed.slice(comma + 1), 'base64')
    if (bytes.length > maxBytes)
        throw new FileSourceError(`file exceeds ${maxBytes} bytes`)
    return {
        name: ensureExtension(filename || 'upload', contentType),
        contentType,
        bytes
    }
}

const fetchRemoteFile = async (
    rawUrl: string,
    contentTypeHint: string | undefined,
    filename: string | undefined,
    maxBytes: number
): Promise<ResolvedFile> => {
    let safeUrl: URL
    try {
        safeUrl = await assertPublicHttpUrl(rawUrl, { allowEnvBypass: false })
    } catch (err) {
        throw new FileSourceError(
            `file URL is not allowed: ${(err as Error).message}`
        )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
        const res = await fetch(safeUrl.toString(), {
            redirect: 'error',
            signal: controller.signal
        }).catch((err) => {
            throw new FileSourceError(
                `could not fetch file URL: ${(err as Error).message}`
            )
        })
        if (!res.ok)
            throw new FileSourceError(`file URL returned ${res.status}`)
        if (!res.body) throw new FileSourceError('file URL response had no body')
        const reader = res.body.getReader()
        const chunks: Buffer[] = []
        let total = 0
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            const buf = Buffer.from(value)
            total += buf.length
            if (total > maxBytes) {
                await reader.cancel().catch(() => undefined)
                throw new FileSourceError(`file exceeds ${maxBytes} bytes`)
            }
            chunks.push(buf)
        }
        const contentType =
            res.headers.get('content-type')?.split(';')[0]?.trim() ||
            contentTypeHint ||
            'application/octet-stream'
        return {
            name: ensureExtension(
                filename || nameFromUrl(safeUrl),
                contentType
            ),
            contentType,
            bytes: Buffer.concat(chunks)
        }
    } finally {
        clearTimeout(timer)
    }
}

const nameFromUrl = (url: URL): string =>
    url.pathname.split('/').filter(Boolean).at(-1) || 'upload'

// `image_url` parts carry no filename, so a base64 data: URL resolves to
// "upload" and a URL like ".../png?text=..." to "png" — both extensionless.
// Downstream the attachment is written to the agent workspace verbatim, and
// Claude Code's Read tool keys off the extension to decide image-vs-text: an
// extensionless image gets read as raw bytes instead of rendered. Append an
// extension derived from the content type whenever the name lacks one.
const MIME_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/html': 'html',
    'text/csv': 'csv',
    'application/json': 'json'
}

const ensureExtension = (name: string, contentType: string): string => {
    const base = name.split(/[\\/]/).pop() ?? name
    const dot = base.lastIndexOf('.')
    if (dot > 0 && dot < base.length - 1) return name
    const ext = MIME_EXTENSIONS[contentType.toLowerCase()]
    return ext ? `${name}.${ext}` : name
}

export class FileSourceError extends Error {}
