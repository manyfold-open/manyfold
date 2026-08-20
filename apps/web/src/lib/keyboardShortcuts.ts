export interface KeyboardShortcut {
    alt?: boolean
    code?: string
    ctrl?: boolean
    key?: string
    meta?: boolean
    shift?: boolean
}

export const matchesKeyboardShortcut = (
    event: KeyboardEvent,
    shortcut: KeyboardShortcut
): boolean => {
    const keyMatches = shortcut.key
        ? event.key.toLowerCase() === shortcut.key.toLowerCase()
        : true
    const codeMatches = shortcut.code ? event.code === shortcut.code : true

    return (
        Boolean(shortcut.key || shortcut.code) &&
        keyMatches &&
        codeMatches &&
        event.altKey === (shortcut.alt ?? false) &&
        event.ctrlKey === (shortcut.ctrl ?? false) &&
        event.metaKey === (shortcut.meta ?? false) &&
        event.shiftKey === (shortcut.shift ?? false)
    )
}
