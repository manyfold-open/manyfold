import { lookupBuiltIn } from '@manyfold/shared'
import type { UserModelProviderSummary } from '@manyfold/shared'

// Reserved path segment under model-providers/*. Provider selection lives in
// a query param, so the path never carries an id to collide with.
export const DASHBOARD_SEGMENT = 'dashboard'

export type Selection =
    | { kind: 'configured'; id: string }
    | { kind: 'managed' }
    | { kind: 'builtin'; builtInId: string }
    | { kind: 'custom-new' }

export const selectionToParam = (s: Selection | null): string => {
    if (!s) return ''
    if (s.kind === 'configured') return s.id
    if (s.kind === 'managed') return 'managed'
    if (s.kind === 'builtin') return `builtin:${s.builtInId}`
    return 'custom-new'
}

export const selectionFromParam = (
    raw: string | null,
    items: UserModelProviderSummary[],
    hasManaged: boolean
): Selection | null => {
    if (!raw) return null
    if (raw === 'custom-new') return { kind: 'custom-new' }
    if (raw === 'managed') return hasManaged ? { kind: 'managed' } : null
    if (raw.startsWith('builtin:')) {
        const id = raw.slice('builtin:'.length)
        if (lookupBuiltIn(id)) return { kind: 'builtin', builtInId: id }
        return null
    }
    if (items.some((i) => i.id === raw && i.source !== 'managed'))
        return { kind: 'configured', id: raw }
    return null
}

export const selectionsEqual = (
    a: Selection | null,
    b: Selection | null
): boolean => {
    if (a === b) return true
    if (!a || !b) return false
    if (a.kind !== b.kind) return false
    if (a.kind === 'configured' && b.kind === 'configured') return a.id === b.id
    if (a.kind === 'builtin' && b.kind === 'builtin')
        return a.builtInId === b.builtInId
    return true
}

// What the pane should show for a URL. The dashboard segment is a selection of
// its own and outranks the query param — the page renders the dashboard when
// this is null, so a stale param must not keep a provider open behind it, and
// the rail must not light one up beside it.
export const providerSelectionFor = (input: {
    onDashboard: boolean
    param: string | null
    items: UserModelProviderSummary[]
    hasManaged: boolean
}): Selection | null =>
    input.onDashboard
        ? null
        : selectionFromParam(input.param, input.items, input.hasManaged)
