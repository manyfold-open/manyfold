// Per-area grid/list preference. Each dashboard owns its own key so switching
// one surface to a table does not silently retype the others.
export type DashboardView = 'grid' | 'list'

export const RUNTIMES_DASHBOARD_VIEW_KEY = 'mf.runtimes.dashboardView.v1'
export const MODEL_PROVIDERS_DASHBOARD_VIEW_KEY =
    'mf.modelProviders.dashboardView.v1'
export const CHANNELS_DASHBOARD_VIEW_KEY = 'mf.channels.dashboardView.v1'
export const API_TOKENS_DASHBOARD_VIEW_KEY = 'mf.apiTokens.dashboardView.v1'
// Agent create's runtime picker is not a dashboard, but it lists the same
// objects in the same two shapes, so it reuses the toggle and keeps its own key.
export const AGENT_NEW_RUNTIME_VIEW_KEY = 'mf.agentNew.runtimeView.v1'

const defaultView: DashboardView = 'grid'

export const normalizeDashboardView = (raw: unknown): DashboardView =>
    raw === 'list' || raw === 'grid' ? raw : defaultView

export const readDashboardView = (storageKey: string): DashboardView => {
    if (typeof window === 'undefined') return defaultView
    try {
        return normalizeDashboardView(window.localStorage.getItem(storageKey))
    } catch {
        return defaultView
    }
}

export const writeDashboardView = (
    storageKey: string,
    view: DashboardView
): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(storageKey, view)
    } catch {
        // ignore quota / disabled storage
    }
}
