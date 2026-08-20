import type { SpriteStatus } from '@manyfold/shared'

// sprites.dev host lifecycle, per https://docs.sprites.dev/concepts/lifecycle.
// A sandbox VM is the agent host; its status is this lifecycle, NOT the runtime
// provisioning state (ready/pending/...). active = doing work (billed); warm =
// suspended in RAM, wakes in <0.5s; cold = fully stopped, wakes in 1-2s. null =
// the status sync has not reported yet (freshly provisioned).
export type SpriteTone = 'success' | 'warning' | 'idle'

const TONE: Record<SpriteStatus, SpriteTone> = {
    running: 'success',
    warm: 'warning',
    cold: 'idle'
}

const DOT: Record<SpriteTone, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    idle: 'bg-idle'
}

const LABEL: Record<SpriteStatus, string> = {
    running: 'Active',
    warm: 'Warm',
    cold: 'Cold'
}

export const spriteStatusTone = (status: SpriteStatus | null): SpriteTone =>
    status ? TONE[status] : 'idle'

export const spriteStatusLabel = (status: SpriteStatus | null): string =>
    status ? LABEL[status] : 'Provisioning'

export const spriteStatusDotClass = (status: SpriteStatus | null): string =>
    DOT[spriteStatusTone(status)]