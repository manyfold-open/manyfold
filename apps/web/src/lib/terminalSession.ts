export const isUpstreamTerminalSessionInfo = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const frame = value as {
        type?: unknown
        session_id?: unknown
        terminal_pty?: unknown
    }
    if (frame.type !== 'session_info') return false
    // A PTY on the host's daemon (ADR-0037) is opened by the gateway itself
    // and says so with `terminal_pty`, whatever the placement: that frame is
    // the open signal. A failed pty.open follows with an error frame and a
    // non-reconnectable close, never the 502 loop the session-id rule below
    // guards for an exec-backed shell.
    if (typeof frame.terminal_pty === 'boolean') return true
    return typeof frame.session_id === 'string' && frame.session_id.length > 0
}

// The API closes a tab's socket with this code when another attachment took
// over the terminal the tab was showing (ADR-0029 §6). The terminal is
// alive, just elsewhere: no reconnect, or the two tabs would trade it back
// and forth.
export const TERMINAL_CLOSE_ATTACHED_ELSEWHERE = 4409

export const isTerminalAttachedElsewhereClose = (code: number): boolean =>
    code === TERMINAL_CLOSE_ATTACHED_ELSEWHERE
