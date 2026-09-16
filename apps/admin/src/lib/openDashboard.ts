import type { AgentControlUiUrlResponse } from '@manyfold/shared'
import { captureMessage } from '@sentry/react'

const DASHBOARD_MINT_TIMEOUT_MS = 10_000

// Minimum API surface the popup opener needs from a runtimes client. Lets
// callers pass either `client.agentRuntimes` (user) or
// `client.admin.agentRuntimes` (admin) without coupling to the full SDK.
export interface ControlUiUrlMinter {
    getControlUiUrl: (
        runtimeId: string,
        agentId?: string,
        opts?: { signal?: AbortSignal }
    ) => Promise<AgentControlUiUrlResponse>
}

export interface OpenDashboardOptions {
    runtimeId: string
    agentId?: string
    failureTitle?: string
    popupBlockedMessage?: string
    timeoutMs?: number
    // Sync gate run inside the click handler before opening the popup, so
    // browser popup-blocker heuristics still treat it as a user gesture.
    // Return false to abort.
    confirm?: () => boolean
}

const renderPopupError = (
    win: Window,
    title: string,
    message: string
): boolean => {
    try {
        if (win.closed) return false
        const doc = win.document
        if (!doc?.body) return false
        doc.title = title
        doc.body.replaceChildren()
        const heading = doc.createElement('h1')
        heading.textContent = title
        heading.style.cssText =
            'font: 600 14px system-ui, sans-serif; margin: 16px 16px 8px;'
        const pre = doc.createElement('pre')
        pre.textContent = message
        pre.style.cssText =
            'margin: 0 16px 16px; white-space: pre-wrap; font: 12px ui-monospace, monospace;'
        doc.body.appendChild(heading)
        doc.body.appendChild(pre)
        return true
    } catch {
        // WindowProxy can close, navigate or lose DOM access while minting.
        return false
    }
}

// Open a runtime's dashboard / control UI in a new tab. Server-side
// `getControlUiUrl` mints the URL (with audit log) for any framework that
// has one — narranexus / openclaw / hermes — and rejects with a clear
// error for disabled / unsupported runtimes.
//
// Must be invoked synchronously inside a click handler; the empty popup
// is opened first and then navigated, because browsers suppress popups
// opened from async continuations.
export const openDashboardInPopup = (
    runtimes: ControlUiUrlMinter,
    opts: OpenDashboardOptions
): void => {
    const failureTitle = opts.failureTitle ?? 'Failed to open dashboard'
    const popupBlockedMsg =
        opts.popupBlockedMessage ??
        'Popup blocked. Allow popups for this site, then try again.'
    const timeoutMs = opts.timeoutMs ?? DASHBOARD_MINT_TIMEOUT_MS
    if (opts.confirm && !opts.confirm()) return
    const win = window.open('', '_blank')
    if (!win) {
        window.alert(popupBlockedMsg)
        return
    }
    const controller = new AbortController()
    const timeoutId = window.setTimeout(
        () => controller.abort(),
        timeoutMs
    )
    void (async () => {
        let phase: 'mint' | 'navigate' = 'mint'
        try {
            const { url } = await runtimes.getControlUiUrl(
                opts.runtimeId,
                opts.agentId,
                { signal: controller.signal }
            )
            phase = 'navigate'
            win.location.replace(url)
        } catch (e) {
            const aborted = controller.signal.aborted
            const msg = aborted
                ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
                : e instanceof Error
                  ? e.message
                  : failureTitle
            // Error details can contain the freshly minted credential URL.
            captureMessage('Dashboard could not be opened', {
                level: 'warning',
                tags: { operation: 'dashboard.open', phase: aborted ? 'timeout' : phase }
            })
            if (!renderPopupError(win, failureTitle, msg))
                window.alert(`${failureTitle}\n\n${msg}`)
        } finally {
            window.clearTimeout(timeoutId)
        }
    })()
}
