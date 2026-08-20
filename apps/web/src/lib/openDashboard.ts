import type { AgentControlUiUrlResponse } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'

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
): void => {
    const doc = win.document
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
        try {
            const { url } = await runtimes.getControlUiUrl(
                opts.runtimeId,
                opts.agentId,
                { signal: controller.signal }
            )
            win.location.replace(url)
        } catch (e) {
            const aborted = controller.signal.aborted
            const msg = aborted
                ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
                : (e as Error).message
            renderPopupError(win, failureTitle, msg)
        } finally {
            window.clearTimeout(timeoutId)
        }
    })()
}

// Whether this agent exposes a dashboard/control UI at all. Frameworks differ:
// narranexus always has one, openclaw and hermes gate it behind a toggle, and
// every other framework has none.
export const agentHasDashboard = (agent: SdkAgent): boolean => {
    if (!agent.ingressHost || !agent.runtimeId) return false
    switch (agent.framework) {
        case 'narranexus':
            return true
        case 'openclaw':
            return agent.controlUiEnabled
        case 'hermes':
            return agent.dashboardEnabled
        default:
            return false
    }
}

// Returns null when there is nothing to open, which is also how the agent menu
// decides whether to render its `Open dashboard ↗` item.
export const agentDashboardOpener = (
    agent: SdkAgent,
    runtimes: ControlUiUrlMinter,
    t: (key: string) => string
): (() => void) | null => {
    if (!agentHasDashboard(agent)) return null
    const runtimeId = agent.runtimeId
    if (!runtimeId) return null
    return () => {
        openDashboardInPopup(runtimes, {
            runtimeId,
            agentId: agent.id,
            failureTitle: t('web.shell.openDashboardFailedTitle'),
            popupBlockedMessage: t('web.shell.openDashboardPopupBlocked')
        })
    }
}
