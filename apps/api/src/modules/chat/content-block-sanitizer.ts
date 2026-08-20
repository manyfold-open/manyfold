import type { ChatContentBlock } from '@manyfold/shared'

// Strip the absolute host mount prefix from attachment/context_ref paths so the
// public surface never leaks internal layout (…/.manyfold/workspaces/<id>/…). Prefer
// the workspace-relative path; fall back to the basename. Exact policy (relativize
// vs. drop) is pending owner confirmation — see ADR-0005 follow-up.
export const sanitizeBlock = (block: ChatContentBlock): ChatContentBlock => {
    if (block.type === 'attachment' || block.type === 'context_ref')
        return { ...block, path: relativizeWorkspacePath(block.path) }
    return block
}

const WORKSPACE_PREFIX_RE = /^.*?\/workspaces\/[^/]+\//

const relativizeWorkspacePath = (path: string): string => {
    const stripped = path.replace(WORKSPACE_PREFIX_RE, '')
    if (stripped !== path) return stripped
    return path.split('/').filter(Boolean).at(-1) ?? path
}

// Mirrors GRANT_URL_SOURCE in apps/web grantPermissionLinks.ts. A grant URL in
// a transcript carries the consent token — a live capability that must never
// reach the anonymous share surface.
const GRANT_URL_RE = /https?:\/\/[^\s)<>"'`]*\/grant-permission\?[^\s)<>"'`]*/gi
const GRANT_URL_PLACEHOLDER = '[permission link removed]'

const scrubGrantUrls = (text: string): string =>
    text.replace(GRANT_URL_RE, GRANT_URL_PLACEHOLDER)

const scrubJsonStrings = <T>(value: T): T => {
    const serialized = JSON.stringify(value)
    if (!serialized.includes('/grant-permission?')) return value
    // The URL character class excludes quotes, so replacing inside the
    // serialized form cannot break JSON structure.
    return JSON.parse(scrubGrantUrls(serialized)) as T
}

export const sanitizeSharedBlock = (
    block: ChatContentBlock
): ChatContentBlock => {
    const base = sanitizeBlock(block)
    if (base.type === 'text' || base.type === 'thinking')
        return { ...base, text: scrubGrantUrls(base.text) }
    if (base.type === 'upload') return { ...base, uploadId: '' }
    if (base.type === 'tool_call' || base.type === 'tool_result')
        return scrubJsonStrings(base)
    return base
}

export const sanitizeSharedBlocks = (
    blocks: ChatContentBlock[]
): ChatContentBlock[] => blocks.map(sanitizeSharedBlock)
