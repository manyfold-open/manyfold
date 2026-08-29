import type {
    ChatAttachmentBlock,
    ChatContentBlock,
    ChatContextRefBlock,
    ChatPermissionRequestBlock,
    ChatPermissionResolutionBlock,
    ChatTextBlock,
    ChatThinkingBlock,
    ChatToolCallBlock,
    ChatToolResultBlock,
    ChatUploadBlock
} from '@manyfold/shared'

export type ToolStatus = 'running' | 'completed' | 'error' | 'denied'

export interface PairedToolBlock {
    kind: 'paired_tool'
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
    status: ToolStatus
}

export interface SubagentBlock {
    kind: 'subagent'
    call: ChatToolCallBlock
    result?: ChatToolResultBlock
    status: ToolStatus
    children: PairedToolBlock[]
}

export interface OrphanResultBlock {
    kind: 'orphan_result'
    result: ChatToolResultBlock
    status: ToolStatus
}

// A hermes ask and (once answered / expired / cancelled) its settlement,
// paired by requestId the same way tool calls pair with their results.
export interface PermissionCardBlock {
    kind: 'permission_card'
    request: ChatPermissionRequestBlock
    resolution: ChatPermissionResolutionBlock | null
}

export type RenderableBlock =
    | { kind: 'text'; block: ChatTextBlock }
    | { kind: 'attachment'; block: ChatAttachmentBlock }
    | { kind: 'context_ref'; block: ChatContextRefBlock }
    | { kind: 'upload'; block: ChatUploadBlock }
    | { kind: 'thinking'; block: ChatThinkingBlock }
    | PairedToolBlock
    | SubagentBlock
    | OrphanResultBlock
    | PermissionCardBlock

const DENIED_PATTERNS = [
    'user denied tool use',
    'user rejected the tool',
    'permission request timed out',
    'denied by user',
    'permission denied'
]

const deriveStatus = (
    result: ChatToolResultBlock | undefined,
    streaming: boolean
): ToolStatus => {
    if (!result) return streaming ? 'running' : 'completed'
    const raw = result.result
    const text = extractResultText(raw).toLowerCase()
    if (isErrorShape(raw)) return 'error'
    if (DENIED_PATTERNS.some((p) => text.includes(p))) return 'denied'
    return 'completed'
}

const isErrorShape = (raw: unknown): boolean => {
    if (!raw || typeof raw !== 'object') return false
    const obj = raw as Record<string, unknown>
    if (obj.isError === true) return true
    if (obj.is_error === true) return true
    if (typeof obj.error === 'string' && obj.error.length > 0) return true
    return false
}

export const extractResultText = (raw: unknown): string => {
    if (raw == null) return ''
    if (typeof raw === 'string') return raw
    if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>
        if (typeof obj.content === 'string') return obj.content
        if (typeof obj.text === 'string') return obj.text
        if (typeof obj.output === 'string') return obj.output
        if (typeof obj.stdout === 'string') return obj.stdout
        if (Array.isArray(obj.content)) {
            return (obj.content as Array<Record<string, unknown>>)
                .map((c) =>
                    typeof c?.text === 'string' ? (c.text as string) : ''
                )
                .join('\n')
        }
    }
    try {
        return JSON.stringify(raw)
    } catch {
        return String(raw)
    }
}

export interface PairOptions {
    streaming?: boolean
    nestSubagents?: boolean
}

type Slot =
    | { kind: 'top'; idx: number }
    | { kind: 'subagent_child'; subagentIdx: number; childIdx: number }

const SUBAGENT_TOOL_NAMES = new Set(['Task'])

export const pairToolBlocks = (
    blocks: ChatContentBlock[],
    options: PairOptions = {}
): RenderableBlock[] => {
    const { streaming = false, nestSubagents = false } = options
    const slotById = new Map<string, Slot>()
    const permissionCardIdxByRequest = new Map<string, number>()
    const out: RenderableBlock[] = []
    let activeSubagentIdx: number | null = null

    for (const block of blocks) {
        if (block.type === 'text') {
            out.push({ kind: 'text', block })
            continue
        }
        if (block.type === 'attachment') {
            out.push({ kind: 'attachment', block })
            continue
        }
        if (block.type === 'context_ref') {
            out.push({ kind: 'context_ref', block })
            continue
        }
        if (block.type === 'upload') {
            out.push({ kind: 'upload', block })
            continue
        }
        if (block.type === 'thinking') {
            out.push({ kind: 'thinking', block })
            continue
        }
        if (block.type === 'permission_request') {
            permissionCardIdxByRequest.set(block.requestId, out.length)
            out.push({
                kind: 'permission_card',
                request: block,
                resolution: null
            })
            continue
        }
        if (block.type === 'permission_resolution') {
            const idx = permissionCardIdxByRequest.get(block.requestId)
            if (idx === undefined) continue
            const existing = out[idx]
            if (existing.kind === 'permission_card')
                out[idx] = { ...existing, resolution: block }
            continue
        }
        if (block.type === 'tool_call') {
            if (nestSubagents && SUBAGENT_TOOL_NAMES.has(block.toolName)) {
                const idx = out.length
                out.push({
                    kind: 'subagent',
                    call: block,
                    children: [],
                    status: 'running'
                })
                slotById.set(block.toolCallId, { kind: 'top', idx })
                activeSubagentIdx = idx
                continue
            }
            if (activeSubagentIdx != null) {
                const subagent = out[activeSubagentIdx] as SubagentBlock
                const childIdx = subagent.children.length
                subagent.children.push({
                    kind: 'paired_tool',
                    call: block,
                    status: 'running'
                })
                slotById.set(block.toolCallId, {
                    kind: 'subagent_child',
                    subagentIdx: activeSubagentIdx,
                    childIdx
                })
                continue
            }
            const idx = out.length
            out.push({
                kind: 'paired_tool',
                call: block,
                status: streaming ? 'running' : 'completed'
            })
            slotById.set(block.toolCallId, { kind: 'top', idx })
            continue
        }
        if (block.type === 'tool_result') {
            const slot = slotById.get(block.toolCallId)
            if (!slot) {
                out.push({
                    kind: 'orphan_result',
                    result: block,
                    status: deriveStatus(block, false)
                })
                continue
            }
            if (slot.kind === 'top') {
                const existing = out[slot.idx]
                if (existing.kind === 'paired_tool') {
                    out[slot.idx] = {
                        ...existing,
                        result: block,
                        status: deriveStatus(block, false)
                    }
                } else if (existing.kind === 'subagent') {
                    out[slot.idx] = {
                        ...existing,
                        result: block,
                        status: deriveStatus(block, false)
                    }
                    if (activeSubagentIdx === slot.idx) activeSubagentIdx = null
                }
            } else {
                const subagent = out[slot.subagentIdx] as SubagentBlock
                const child = subagent.children[slot.childIdx]
                subagent.children[slot.childIdx] = {
                    ...child,
                    result: block,
                    status: deriveStatus(block, false)
                }
            }
        }
    }

    if (streaming && out.length > 0) {
        const last = out[out.length - 1]
        if (last.kind === 'paired_tool' && !last.result) {
            out[out.length - 1] = { ...last, status: 'running' }
        }
    }

    return out
}
