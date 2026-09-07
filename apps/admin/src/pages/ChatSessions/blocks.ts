import type {
    ChatAttachmentBlock,
    ChatContentBlock,
    ChatContextRefBlock,
    ChatUploadBlock
} from '@manyfold/shared'

export interface FoldedBlocks {
    // The text blocks joined in order: the answer as the user saw it, or the
    // prompt as they typed it.
    text: string
    // Everything that is not text and not an attachment kind, in stream
    // order, so a tool call still sits next to its result.
    extras: ChatContentBlock[]
    attachments: ChatAttachmentBlock[]
    contextRefs: ChatContextRefBlock[]
    uploads: ChatUploadBlock[]
}

const isBlock = (value: unknown): value is ChatContentBlock =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'

// `blocks` arrives as jsonb this page did not write. Every writer goes through
// the assistant block buffer and hands drizzle an array of tagged objects, but
// a row recovered from a runtime session file or written by an older shape is
// not something the page gets to assume — so anything unrecognised is carried
// into `extras` (where it renders as raw JSON) rather than dropped or trusted.
export const foldBlocks = (blocks: unknown): FoldedBlocks => {
    const folded: FoldedBlocks = {
        text: '',
        extras: [],
        attachments: [],
        contextRefs: [],
        uploads: []
    }
    if (!Array.isArray(blocks)) return folded

    const text: string[] = []
    for (const block of blocks) {
        if (!isBlock(block)) continue
        if (block.type === 'text') {
            if (typeof block.text === 'string') text.push(block.text)
            continue
        }
        if (block.type === 'attachment') folded.attachments.push(block)
        else if (block.type === 'context_ref') folded.contextRefs.push(block)
        else if (block.type === 'upload') folded.uploads.push(block)
        else folded.extras.push(block)
    }
    folded.text = text.join('').trim()
    return folded
}

const EXTRA_LABELS: Record<string, [string, string]> = {
    thinking: ['thinking block', 'thinking blocks'],
    tool_call: ['tool call', 'tool calls'],
    tool_result: ['tool result', 'tool results'],
    permission_request: ['permission request', 'permission requests'],
    permission_resolution: ['permission resolution', 'permission resolutions']
}

// What the extras toggle says before it is opened. Known kinds come first in a
// fixed order so the label stays comparable between turns; an unknown kind
// keeps its raw type, because inventing a friendly name for a block shape this
// build does not know would be a guess.
export const foldedExtrasLabel = (folded: FoldedBlocks): string | null => {
    if (folded.extras.length === 0) return null
    const counts = new Map<string, number>()
    for (const block of folded.extras)
        counts.set(block.type, (counts.get(block.type) ?? 0) + 1)
    const known = Object.keys(EXTRA_LABELS).filter((type) => counts.has(type))
    const unknown = [...counts.keys()]
        .filter((type) => !(type in EXTRA_LABELS))
        .sort()
    return [...known, ...unknown]
        .map((type) => {
            const count = counts.get(type) ?? 0
            const labels = EXTRA_LABELS[type]
            if (!labels) return `${count} × ${type}`
            return `${count} ${count === 1 ? labels[0] : labels[1]}`
        })
        .join(' · ')
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']

export const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '? B'
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024
        unit += 1
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}
