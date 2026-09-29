import {
    StorageMeasurementError,
    type StorageFailureClass
} from '@/common/telemetry/storage-measurement-error'
import { HostDaemonOfflineError } from '@/modules/agents/adapters/host-daemon-access'

export type StorageMeasurementPhase =
    | 'prepare'
    | 'connect'
    | 'first_byte'
    | 'df'
    | 'workspace_du'
    | 'home_du'
    | 'persist'
export type StorageMeasurementTrigger =
    'chat' | 'status_sync' | 'terminal' | 'manual' | 'unspecified'

export const STORAGE_PHASE_MARKER = '__NCA_STORAGE_PHASE__'
export const MEASUREMENT_FORMAT_VERSION = 1

export const storageFailureClass = (
    error: unknown,
    phase: StorageMeasurementPhase
): StorageFailureClass => {
    if (error instanceof StorageMeasurementError) return error.failureClass
    if (error instanceof HostDaemonOfflineError) return 'transport'
    if (error instanceof Error && /timed out/.test(error.message))
        return 'timeout'
    return phase === 'persist' ? 'persistence' : 'unknown'
}

export class MeasurementObservation {
    readonly startedAt = performance.now()
    execTimeoutMs: number | undefined
    phase: StorageMeasurementPhase = 'prepare'
    readonly timings = new Map<
        StorageMeasurementPhase,
        { durationMs: number; count: number }
    >()
    private readonly starts = new Map<StorageMeasurementPhase, number>()
    private partial = ''
    private opaqueFields = 0
    private execStarted = 0
    private connectedAt = 0
    private firstByte = false

    constructor(
        readonly id: string,
        readonly trigger: StorageMeasurementTrigger
    ) {}

    startExec(timeoutMs: number): void {
        this.execTimeoutMs = timeoutMs
        this.execStarted = performance.now()
        this.phase = 'connect'
    }

    // The daemon answers: what is left is the command itself.
    connected(): void {
        this.connectedAt = performance.now()
        this.record('connect', this.connectedAt - this.execStarted)
        this.phase = 'first_byte'
    }

    // The script's own output as it arrives: each phase is timed by the clock
    // of the machine it ran on, from the markers around it.
    stdout(chunk: string): void {
        if (!this.firstByte) {
            this.firstByte = true
            this.record('first_byte', performance.now() - this.connectedAt)
        }
        let timingText = ''
        // Path records have four NUL delimiters. They never enter the phase
        // buffer, including when a private path contains a newline/marker.
        for (const character of chunk) {
            if (this.opaqueFields) {
                if (character === '\0') this.opaqueFields--
            } else if (character === '\0') this.opaqueFields = 3
            else timingText += character
        }
        const lines = (this.partial + timingText).split('\n')
        this.partial = (lines.pop() ?? '').slice(-256)
        for (const line of lines) {
            const match =
                /^__NCA_STORAGE_PHASE__ (df|workspace_du|home_du) (start|end) (\d{1,20})$/.exec(
                    line
                )
            if (!match) continue
            const phase = match[1] as StorageMeasurementPhase
            const microseconds = Number(match[3])
            if (!Number.isSafeInteger(microseconds)) continue
            this.phase = phase
            if (match[2] === 'start') this.starts.set(phase, microseconds)
            else {
                const start = this.starts.get(phase)
                if (start !== undefined && microseconds >= start)
                    this.record(phase, (microseconds - start) / 1000)
                this.starts.delete(phase)
            }
        }
    }

    private record(phase: StorageMeasurementPhase, durationMs: number): void {
        const previous = this.timings.get(phase)
        this.timings.set(phase, {
            durationMs: (previous?.durationMs ?? 0) + durationMs,
            count: (previous?.count ?? 0) + 1
        })
    }
}
