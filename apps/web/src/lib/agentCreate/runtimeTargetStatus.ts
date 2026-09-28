import type {
    RuntimeAuthAvailability,
    RuntimeHostPowerState,
    RuntimeHostStatus
} from '@manyfold/shared'
import type { TagTone } from '@/components/Tag'
import { machineLabel, machineTone } from '@/lib/hostStatus'

// What a sandbox card's status line says. The picked sandbox reports the
// daemon the form is bringing up for it (starting, then answering); every
// other sandbox reports the machine itself, in the colour and the words the
// runtime list uses.
export type SandboxTargetStatus =
    | { kind: 'starting-runner' }
    | { kind: 'runner-online' }
    | { kind: 'host'; label: string; tone: TagTone }

export const sandboxTargetStatus = (input: {
    hostStatus: RuntimeHostStatus | null
    powerState: RuntimeHostPowerState | null
    daemonOnline: boolean | null
    picked: boolean
    prewarming: boolean
    availability: RuntimeAuthAvailability | null
}): SandboxTargetStatus => {
    if (input.picked && input.prewarming) return { kind: 'starting-runner' }
    if (input.picked && input.availability === 'ok')
        return { kind: 'runner-online' }
    const machine = {
        kind: 'hosted',
        status: input.hostStatus,
        powerState: input.powerState,
        daemonOnline: input.daemonOnline
    } as const
    return {
        kind: 'host',
        label: machineLabel(machine),
        tone: machineTone(machine)
    }
}
