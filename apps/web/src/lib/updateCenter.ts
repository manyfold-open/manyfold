import {
    displayStatus,
    isRunnableUpdate,
    kindParamOf
} from '@manyfold/shared'
import type { UpdateKind, UpdateRow, UpdateStatus } from '@manyfold/shared'

// The model moved to @manyfold/shared so `mf updates` builds the same rows;
// this module keeps what only the page needs and re-exports the rest.
export {
    SKILL_INSTALL_BATCH_LIMIT,
    blockerStatus,
    buildUpdateRows,
    countUpdates,
    displayStatus,
    emptyUpdateCenterInputs,
    filterRowsByKind,
    kindParamOf,
    parseKindParam,
    planBatch,
    sandboxFrameworkUpdateId,
    shortRevision,
    skillUpdateId
} from '@manyfold/shared'
export type {
    BatchStep,
    UpdateCenterInputs,
    UpdateKind,
    UpdateRow,
    UpdateStatus,
    UpdateTargetKind
} from '@manyfold/shared'

export type UpdateGroupBy = 'kind' | 'target' | 'status' | 'none'

export const updateGroupDims: readonly UpdateGroupBy[] = [
    'kind',
    'target',
    'status',
    'none'
]

export interface UpdateGroup {
    key: string
    label: string
    rows: UpdateRow[]
}

const statusOrder: UpdateStatus[] = ['required', 'ready', 'manual', 'offline']

// Groups follow the sort order already applied to the rows, except for status,
// which has a severity order of its own that first appearance would not honour.
export const groupUpdateRows = (
    rows: UpdateRow[],
    groupBy: UpdateGroupBy,
    labels: {
        kind: (kind: UpdateKind) => string
        status: (status: UpdateStatus) => string
        all: string
    }
): UpdateGroup[] => {
    if (groupBy === 'none')
        return rows.length === 0
            ? []
            : [{ key: 'all', label: labels.all, rows }]

    const order: string[] = []
    const byKey = new Map<string, UpdateGroup>()
    for (const row of rows) {
        const key =
            groupBy === 'kind'
                ? `kind:${row.kind}`
                : groupBy === 'target'
                  ? `target:${row.targetKey}`
                  : `status:${displayStatus(row)}`
        const label =
            groupBy === 'kind'
                ? labels.kind(row.kind)
                : groupBy === 'target'
                  ? row.targetLabel
                  : labels.status(displayStatus(row))
        let group = byKey.get(key)
        if (!group) {
            group = { key, label, rows: [] }
            byKey.set(key, group)
            order.push(key)
        }
        group.rows.push(row)
    }
    const keys =
        groupBy === 'status'
            ? statusOrder
                  .map((status) => `status:${status}`)
                  .filter((key) => byKey.has(key))
            : order
    return keys.map((key) => byKey.get(key) as UpdateGroup)
}

// The one spelling of the link every existing update reminder now points at.
export const updatesPath = (kind?: UpdateKind): string =>
    kind ? `/updates?kind=${kindParamOf(kind)}` : '/updates'

export type SelectionState = 'none' | 'some' | 'all'

export const selectionState = (
    ids: readonly string[],
    selected: ReadonlySet<string>
): SelectionState => {
    const count = ids.filter((id) => selected.has(id)).length
    return count === 0 ? 'none' : count === ids.length ? 'all' : 'some'
}

// A mixed box fills up rather than clearing: it is unchecked underneath, and
// a click on an unchecked box checks it.
export const toggleSelection = (
    ids: readonly string[],
    selected: ReadonlySet<string>
): Set<string> => {
    const next = new Set(selected)
    if (selectionState(ids, selected) === 'all')
        for (const id of ids) next.delete(id)
    else for (const id of ids) next.add(id)
    return next
}

// Only a row that can still be run from here stays selected after the rows are
// rebuilt. One that stopped being runnable, like a machine that went offline,
// would otherwise stay checked behind a disabled box that cannot clear it, and
// count towards a batch that skips it. The same set comes back when nothing
// drops, so the state update is a no-op.
export const liveSelection = (
    selected: Set<string>,
    rows: UpdateRow[]
): Set<string> => {
    if (selected.size === 0) return selected
    const live = new Set(
        rows.filter(isRunnableUpdate).map((row) => row.id)
    )
    const next = new Set([...selected].filter((id) => live.has(id)))
    return next.size === selected.size ? selected : next
}
