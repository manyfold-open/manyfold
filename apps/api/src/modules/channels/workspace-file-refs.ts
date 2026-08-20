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
const MD_LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
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
    for (const match of text.matchAll(MD_LINK_RE)) candidates.push(match[1])
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
