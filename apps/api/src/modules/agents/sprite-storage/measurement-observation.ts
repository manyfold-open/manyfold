import { SpritesError, type SpritesLogger } from '@manyfold/sprites'
import {
    StorageMeasurementError,
    type StorageFailureClass
} from '@/common/telemetry/storage-measurement-error'

export type StorageMeasurementPhase =
    | 'prepare'
    | 'connect'
    | 'session'
    | 'first_byte'
    | 'df'
    | 'workspace_du'
    | 'home_du'
    | 'persist'
export type StorageMeasurementTrigger =
    'chat' | 'status_sync' | 'terminal' | 'unspecified'

export const STORAGE_PHASE_MARKER = '__NCA_STORAGE_PHASE__'
export const MEASUREMENT_FORMAT_VERSION = 1

export const storageFailureClass = (
    error: unknown,
    phase: StorageMeasurementPhase
): StorageFailureClass => {
    if (error instanceof StorageMeasurementError) return error.failureClass
    if (error instanceof SpritesError) {
        if (/timed out after \d+ms/.test(error.message)) return 'timeout'
        if (error.code === 'auth') return 'permission'
        return 'transport'
    }
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

    sessionOpened(): void {
        this.record('session', performance.now() - this.execStarted)
    }

    readonly logger: SpritesLogger = {
        debug: (message) => {
            if (message !== 'sprites.exec.open') return
            this.record('connect', performance.now() - this.execStarted)
            this.phase = 'first_byte'
        },
        info: () => {},
        warn: () => {},
        error: () => {}
    }

    stdout(chunk: string): void {
        if (!this.firstByte) {
            this.firstByte = true
            this.record('first_byte', performance.now() - this.execStarted)
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
