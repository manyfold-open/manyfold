export interface SseEvent {
    event: string
    data: string
    id?: string
}

export const parseSseStream = async function* (
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal
): AsyncIterable<SseEvent> {
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let event = ''
    let data: string[] = []
    let id: string | undefined
    const flush = (): SseEvent | null => {
        if (data.length === 0 && !event) return null
        const ev: SseEvent = {
            event: event || 'message',
            data: data.join('\n')
        }
        if (id) ev.id = id
        event = ''
        data = []
        id = undefined
        return ev
    }
    for await (const chunk of body) {
        if (signal.aborted) return
        buffer += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const rawLine = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
            if (line === '') {
                const ev = flush()
                if (ev) yield ev
                continue
            }
            if (line.startsWith(':')) continue
            const colon = line.indexOf(':')
            const field = colon === -1 ? line : line.slice(0, colon)
            const value =
                colon === -1
                    ? ''
                    : line[colon + 1] === ' '
                      ? line.slice(colon + 2)
                      : line.slice(colon + 1)
            if (field === 'event') event = value
            else if (field === 'data') data.push(value)
            else if (field === 'id') id = value
        }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
        const trimmed = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        if (trimmed.length > 0) data.push(trimmed)
        const ev = flush()
        if (ev) yield ev
    }
}
