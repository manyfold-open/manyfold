export type RuntimesDashboardView = 'grid' | 'list'

const storageKey = 'mf.runtimes.dashboardView.v1'
const defaultView: RuntimesDashboardView = 'grid'

export const normalizeDashboardView = (raw: unknown): RuntimesDashboardView =>
    raw === 'list' || raw === 'grid' ? raw : defaultView

export const readDashboardView = (): RuntimesDashboardView => {
    if (typeof window === 'undefined') return defaultView
    try {
        return normalizeDashboardView(window.localStorage.getItem(storageKey))
    } catch {
        return defaultView
    }
}

export const writeDashboardView = (view: RuntimesDashboardView): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(storageKey, view)
    } catch {
        // ignore quota / disabled storage
    }
}
