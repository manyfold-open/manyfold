import type { RuntimeAuthAvailability, SpriteStatus } from '@manyfold/shared'
import { spriteStatusLabel, spriteStatusTone } from '@/lib/spriteStatus'

// What a sandbox card's status line says. The picked sandbox reports the
// runner the form is bringing up for it (starting, then answering); every
// other sandbox reports the VM's own lifecycle (active / warm / cold), the
// same words the runtime list uses, instead of a flat "Ready".
export type SandboxTargetStatus =
    | { kind: 'starting-runner' }
    | { kind: 'runner-online' }
    | { kind: 'sprite'; label: string; tone: 'success' | 'warning' | 'idle' }

export const sandboxTargetStatus = (input: {
    spriteStatus: SpriteStatus | null
    picked: boolean
    prewarming: boolean
    availability: RuntimeAuthAvailability | null
}): SandboxTargetStatus => {
    if (input.picked && input.prewarming) return { kind: 'starting-runner' }
    if (input.picked && input.availability === 'ok')
        return { kind: 'runner-online' }
    return {
        kind: 'sprite',
        label: spriteStatusLabel(input.spriteStatus),
        tone: spriteStatusTone(input.spriteStatus)
    }
}
