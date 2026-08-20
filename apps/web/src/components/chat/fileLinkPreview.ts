export interface WorkspaceFileLinkContext {
    mountPath?: string | null
    workspacePath?: string | null
}

export interface WorkspaceFileLinkTarget {
    relPath: string
    rootId: 'workspace'
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/

export const resolveWorkspaceFileLink = (
    href: string | null | undefined,
    context: WorkspaceFileLinkContext
): WorkspaceFileLinkTarget | null => {
    const path = hrefToPath(href)
    if (!path || path.endsWith('/')) return null

    const strippedPath = stripLineSuffix(path)
    if (!strippedPath || strippedPath.endsWith('/')) return null

    if (strippedPath.startsWith('/')) {
        const relPath = relPathForWorkspaceAbsolutePath(strippedPath, context)
        return relPath ? { rootId: 'workspace', relPath } : null
    }

    const relPath = normalizeRelPath(strippedPath)
    return relPath ? { rootId: 'workspace', relPath } : null
}

const hrefToPath = (href: string | null | undefined): string | null => {
    const trimmed = href?.trim() ?? ''
    if (!trimmed || trimmed.startsWith('#')) return null

    if (trimmed.startsWith('file://')) {
        try {
            return decodePath(new URL(trimmed).pathname)
        } catch {
            return null
        }
    }

    if (SCHEME_RE.test(trimmed)) return null

    const path = trimmed.split(/[?#]/, 1)[0]
    return decodePath(path)
}

const decodePath = (path: string): string | null => {
    try {
        return decodeURIComponent(path)
    } catch {
        return path
    }
}

const relPathForWorkspaceAbsolutePath = (
    path: string,
    context: WorkspaceFileLinkContext
): string | null => {
    for (const root of workspaceRootAliases(context)) {
        if (path === root) return null
        if (!path.startsWith(`${root}/`)) continue
        return normalizeRelPath(path.slice(root.length + 1))
    }
    return null
}

const workspaceRootAliases = (context: WorkspaceFileLinkContext): string[] => {
    const aliases = [
        context.workspacePath,
        context.mountPath,
        '/workspace'
    ].flatMap((path) => (path ? [normalizeAbsPath(path)] : []))
    return Array.from(new Set(aliases))
}

const normalizeAbsPath = (path: string): string => {
    const trimmed = path.trim()
    const abs = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    const normalized = abs.replace(/\/+$/, '')
    return normalized || '/'
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
