// The parts of Navigator the check reads. userAgentData is Chromium-only and
// missing from the DOM lib.
interface DeviceSignals {
    userAgent: string
    maxTouchPoints: number
    userAgentData?: { mobile?: boolean }
}

// iPadOS asks for desktop sites with a Mac user agent; only its touch points
// tell it apart from a Mac.
export const isMobileDevice = (signals: DeviceSignals): boolean =>
    signals.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod/i.test(signals.userAgent) ||
    (/Macintosh/.test(signals.userAgent) && signals.maxTouchPoints > 1)
