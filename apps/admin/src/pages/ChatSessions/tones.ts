import type { AdminChatSessionStatus } from '@manyfold/shared'
import type { BadgeTone } from '@/ui'

export const sessionStatusTone: Record<AdminChatSessionStatus, BadgeTone> = {
    running: 'brand',
    failed: 'error',
    idle: 'neutral'
}

export const turnStateTone = (state: string | null): BadgeTone => {
    if (state === 'failed') return 'error'
    if (state === 'done') return 'success'
    if (state === 'running') return 'brand'
    if (state === 'handoff' || state === 'adopting') return 'warning'
    return 'neutral'
}
