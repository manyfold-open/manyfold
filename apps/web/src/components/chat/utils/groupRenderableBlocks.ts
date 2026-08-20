import type { ChatCapabilities } from '@manyfold/shared'
import type { RenderableBlock, ToolStatus } from './pairToolBlocks'

export type TextLikeRenderable = Extract<
    RenderableBlock,
    { kind: 'text' | 'attachment' | 'context_ref' | 'upload' }
>

export type ActivityRenderable = Exclude<
    RenderableBlock,
    { kind: 'text' | 'attachment' | 'context_ref' | 'upload' }
>

export interface ActivitySummary {
    steps: number
    thoughts: number
    tools: number
    label: string
}

export type RenderableGroup =
    | { kind: 'text-run'; blocks: TextLikeRenderable[] }
    | {
          kind: 'activity-run'
          blocks: ActivityRenderable[]
          status: ToolStatus
          summary: ActivitySummary
      }

export const groupRenderableBlocks = (
    renderable: RenderableBlock[],
    capabilities: ChatCapabilities
): RenderableGroup[] => {
    const out: RenderableGroup[] = []
    let textRun: TextLikeRenderable[] = []
    let activityRun: ActivityRenderable[] = []

    const flushText = (): void => {
        if (textRun.length === 0) return
        out.push({ kind: 'text-run', blocks: textRun })
        textRun = []
    }

    const flushActivity = (): void => {
        if (activityRun.length === 0) return
        out.push({
            kind: 'activity-run',
            blocks: activityRun,
            status: deriveActivityStatus(activityRun),
            summary: summarizeActivities(activityRun)
        })
        activityRun = []
    }

    for (const block of renderable) {
        if (
            block.kind === 'text' ||
            block.kind === 'attachment' ||
            block.kind === 'context_ref' ||
            block.kind === 'upload'
        ) {
            flushActivity()
            textRun.push(block)
            continue
        }

        if (!isActivityEnabled(block, capabilities)) continue
        flushText()
        activityRun.push(block)
    }

    flushText()
    flushActivity()
    return out
}

export const deriveActivityStatus = (
    blocks: ActivityRenderable[]
): ToolStatus => {
    let status: ToolStatus = 'completed'
    for (const block of blocks) {
        const next = block.kind === 'thinking' ? 'completed' : block.status
        status = higherPriorityStatus(status, next)
    }
    return status
}

export const summarizeActivities = (
    blocks: ActivityRenderable[]
): ActivitySummary => {
    let thoughts = 0
    let tools = 0
    for (const block of blocks) {
        if (block.kind === 'thinking') {
            thoughts += 1
        } else {
            tools += 1
        }
    }
    const steps = thoughts + tools
    return {
        steps,
        thoughts,
        tools,
        label: [
            countLabel(steps, 'step'),
            thoughts > 0 ? countLabel(thoughts, 'thought') : null,
            tools > 0 ? countLabel(tools, 'tool') : null
        ]
            .filter(Boolean)
            .join(' · ')
    }
}

const isActivityEnabled = (
    block: ActivityRenderable,
    capabilities: ChatCapabilities
): boolean => {
    if (block.kind === 'thinking') return capabilities.thinking
    return capabilities.toolCalls
}

const higherPriorityStatus = (
    left: ToolStatus,
    right: ToolStatus
): ToolStatus => {
    return statusPriority(right) > statusPriority(left) ? right : left
}

const statusPriority = (status: ToolStatus): number => {
    if (status === 'error') return 3
    if (status === 'denied') return 2
    if (status === 'running') return 1
    return 0
}

const countLabel = (count: number, noun: string): string =>
    `${count} ${noun}${count === 1 ? '' : 's'}`
