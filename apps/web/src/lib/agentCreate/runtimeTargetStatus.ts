import type {
    RuntimeAuthAvailability,
    RuntimeHostPowerState,
    RuntimeHostStatus
} from '@manyfold/shared'
import type { TagTone } from '@/components/Tag'
import {
    hostLifecycleLabel,
    hostLifecycleTone,
    powerStateLabel,
    powerStateTone
} from '@/lib/hostStatus'

// What a sandbox card's status line says. The picked sandbox reports the
// daemon the form is bringing up for it (starting, then answering); every
// other sandbox reports the machine itself — its lifecycle until it is ready,
// then its power state — in the same words the runtime list uses.
export type SandboxTargetStatus =
    | { kind: 'starting-runner' }
    | { kind: 'runner-online' }
    | { kind: 'host'; label: string; tone: TagTone }

export const sandboxTargetStatus = (input: {
    hostStatus: RuntimeHostStatus | null
    powerState: RuntimeHostPowerState | null
    picked: boolean
    prewarming: boolean
    availability: RuntimeAuthAvailability | null
}): SandboxTargetStatus => {
    if (input.picked && input.prewarming) return { kind: 'starting-runner' }
    if (input.picked && input.availability === 'ok')
        return { kind: 'runner-online' }
    if (input.hostStatus !== null && input.hostStatus !== 'ready')
        return {
            kind: 'host',
            label: hostLifecycleLabel(input.hostStatus),
            tone: hostLifecycleTone(input.hostStatus)
        }
    return {
        kind: 'host',
        label: powerStateLabel(input.powerState),
        tone: powerStateTone(input.powerState)
    }
}
