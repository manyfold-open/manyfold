export const isUpstreamTerminalSessionInfo = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const frame = value as { type?: unknown; session_id?: unknown }
    return (
        frame.type === 'session_info' &&
        typeof frame.session_id === 'string' &&
        frame.session_id.length > 0
    )
}
