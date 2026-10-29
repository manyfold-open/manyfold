import { isAllowedChatAttachment } from '@manyfold/shared'

export interface WorkspaceFileRef {
    relPath: string
    name: string
}

const MAX_OUTBOUND_REFS = 4
const IMAGE_EXTENSIONS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'svg',
    'bmp',
    'heic',
    'heif',
    'avif'
])
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const WORKSPACE_ALIASES = ['/workspace']

// Markdown links and images: [label](target) and ![alt](target).
const MD_LINK_RE = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
// Bare file:// URLs that appear outside markdown link syntax.
const FILE_URL_RE = /\bfile:\/\/\S+/g

/**
 * Extract workspace-relative file references an assistant mentioned in its
 * reply text, so a channel can attach them outbound. Ported from the web
 * `resolveWorkspaceFileLink` rules: markdown link/image targets and bare
 * `file://` URLs, resolved to a workspace-relative path (relative paths, or
 * absolute paths under a `/workspace` alias). Filtered to allowed attachment
 * types, deduped, images first, capped.
 */
export const extractWorkspaceFileRefs = (text: string): WorkspaceFileRef[] => {
    if (!text) return []
    const candidates: string[] = []
    for (const match of text.matchAll(MD_LINK_RE)) candidates.push(match[2])
    for (const match of text.matchAll(FILE_URL_RE)) candidates.push(match[0])

    const seen = new Set<string>()
    const refs: WorkspaceFileRef[] = []
    for (const candidate of candidates) {
        const relPath = resolveRelPath(candidate)
        if (!relPath || seen.has(relPath)) continue
        const name = relPath.slice(relPath.lastIndexOf('/') + 1)
        if (!isAllowedChatAttachment({ name })) continue
        seen.add(relPath)
        refs.push({ relPath, name })
    }

    refs.sort((a, b) => imageRank(a.name) - imageRank(b.name))
    return refs.slice(0, MAX_OUTBOUND_REFS)
}

const REMOVED = '\u0000'

/**
 * The reply text a channel shows when it also sends `refs` as attachments.
 * Each reference to one of those files reads as its label instead (an image
 * with no alt text as nothing, a bare `file://` URL as the file name): the
 * file arrives right after the text, and a workspace path means nothing to
 * someone outside Manyfold. A line left empty by this is dropped. Text with
 * nothing left keeps its references, so a reply never goes out blank.
 */
export const stripWorkspaceFileRefs = (
    text: string,
    refs: readonly WorkspaceFileRef[]
): string => {
    if (refs.length === 0) return text
    const sent = new Set(refs.map((ref) => ref.relPath))
    const isSent = (target: string): boolean => {
        const relPath = resolveRelPath(target)
        return relPath !== null && sent.has(relPath)
    }
    let changed = false
    const marked = text
        .replace(MD_LINK_RE, (whole, label: string, target: string) => {
            if (!isSent(target)) return whole
            changed = true
            return label || REMOVED
        })
        .replace(FILE_URL_RE, (url) => {
            const relPath = resolveRelPath(url)
            if (relPath === null || !sent.has(relPath)) return url
            changed = true
            return relPath.slice(relPath.lastIndexOf('/') + 1)
        })
    if (!changed) return text
    const shown = marked
        .split('\n')
        .filter(
            (line) =>
                !line.includes(REMOVED) ||
                line.replaceAll(REMOVED, '').trim() !== ''
        )
        .join('\n')
        .replaceAll(` ${REMOVED}`, '')
        .replaceAll(REMOVED, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '')
    return shown.trim() ? shown : text
}

const imageRank = (name: string): number =>
    IMAGE_EXTENSIONS.has(extensionOf(name)) ? 0 : 1

const extensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const resolveRelPath = (raw: string): string | null => {
    const path = hrefToPath(raw)
    if (!path || path.endsWith('/')) return null
    const stripped = stripLineSuffix(path)
    if (!stripped || stripped.endsWith('/')) return null
    if (stripped.startsWith('/')) {
        for (const root of WORKSPACE_ALIASES) {
            if (stripped === root) return null
            if (stripped.startsWith(`${root}/`))
                return normalizeRelPath(stripped.slice(root.length + 1))
        }
        return null
    }
    return normalizeRelPath(stripped)
}

const hrefToPath = (raw: string): string | null => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    if (trimmed.startsWith('file://')) {
        try {
            return decodePath(new URL(trimmed).pathname)
        } catch {
            return null
        }
    }
    if (SCHEME_RE.test(trimmed)) return null
    return decodePath(trimmed.split(/[?#]/, 1)[0])
}

const decodePath = (path: string): string => {
    try {
        return decodeURIComponent(path)
    } catch {
        return path
    }
}

const normalizeRelPath = (path: string): string | null => {
    const parts: string[] = []
    for (const part of path.replace(/^\.\/+/, '').split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (parts.length === 0) return null
            parts.pop()
            continue
        }
        parts.push(part)
    }
    return parts.length > 0 ? parts.join('/') : null
}

const stripLineSuffix = (path: string): string =>
    path.replace(/(?::\d+){1,2}$/, '')
