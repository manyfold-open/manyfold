export interface ServiceLogEvent {
    type:
        | 'started'
        | 'stopping'
        | 'stopped'
        | 'stdout'
        | 'stderr'
        | 'exit'
        | 'error'
        | 'complete'
        | 'info'
    data?: string
    exit_code?: number
    timestamp?: string
    log_files?: {
        combined?: string
        stdout?: string
        stderr?: string
    }
}

export const parseServiceLogStream = (text: string): ServiceLogEvent[] => {
    if (!text) return []
    const events: ServiceLogEvent[] = []
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
            const parsed = JSON.parse(trimmed) as ServiceLogEvent
            events.push(parsed)
        } catch {
            // ignore non-JSON lines — the platform occasionally emits banner text
        }
    }
    return events
}
