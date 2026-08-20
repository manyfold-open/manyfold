import { SeverityNumber, type LogAttributes } from '@opentelemetry/api-logs'
import { otelEventsLogger } from './otel'

export type ProcessExitReason =
    | 'signal'
    | 'bootstrap_failure'
    | 'uncaught_exception'
    | 'unhandled_rejection'

export type ShutdownOutcome =
    | 'complete'
    | 'close_error'
    | 'forced_timeout'
    | 'fatal'

export interface ProcessExitRecord {
    reason: ProcessExitReason
    shutdownOutcome: ShutdownOutcome
    exitCode: number
    durationMs: number
    signal?: NodeJS.Signals
    errorClass?: string
    errorMessage?: string
    stack?: string
    turnDrainOutcome?: 'idle' | 'drained' | 'timeout'
    activeTurnsAtStart?: number
    activeTurnsRemaining?: number
    handedOffTurns?: number
    handoffOutcome?:
        | 'not_needed'
        | 'handed_off'
        | 'no_adoptable_turns'
        | 'disabled'
        | 'failed'
}

const attributesFor = (record: ProcessExitRecord): LogAttributes => {
    const attributes: LogAttributes = {
        'nca.event': 'process.exit',
        reason: record.reason,
        shutdownOutcome: record.shutdownOutcome,
        exitCode: record.exitCode,
        durationMs: record.durationMs
    }
    for (const [key, value] of Object.entries(record))
        if (value !== undefined) attributes[key] = value
    return attributes
}

export const emitProcessExit = (record: ProcessExitRecord): void => {
    otelEventsLogger()?.emit({
        severityNumber:
            record.exitCode === 0 ? SeverityNumber.INFO : SeverityNumber.ERROR,
        severityText: record.exitCode === 0 ? 'INFO' : 'ERROR',
        body: 'process.exit',
        attributes: attributesFor(record)
    })
}

export const processExitLogLine = (record: ProcessExitRecord): string =>
    `process.exit ${JSON.stringify(record)}`
