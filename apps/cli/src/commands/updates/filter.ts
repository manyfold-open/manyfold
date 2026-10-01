import {
    filterRowsByKind,
    parseKindParam,
    type UpdateCenterInputs,
    type UpdateRow
} from '@manyfold/shared'
import { UsageError } from '@/usage-error'

export interface UpdateFilter {
    kind?: string
    where?: string
}

// `host:sbx_1` → `sbx_1`: the id a person copies from another command.
const idOf = (targetKey: string): string =>
    targetKey.slice(targetKey.indexOf(':') + 1)

const knownPlaces = (
    inputs: UpdateCenterInputs
): Array<{ id: string; name: string }> => [
    ...inputs.daemonHosts.map(({ id, name }) => ({ id, name })),
    ...inputs.sandboxes.map(({ id, name }) => ({ id, name })),
    ...inputs.podHosts.map(({ id, name }) => ({ id, name })),
    ...inputs.runtimes.map(({ id, name }) => ({ id, name })),
    ...inputs.skillGroups.map(({ agent }) => ({ id: agent.id, name: agent.name }))
]

const narrowToPlace = (
    rows: UpdateRow[],
    inputs: UpdateCenterInputs,
    where: string,
    complete: boolean
): UpdateRow[] => {
    const byKey = rows.filter(
        (row) =>
            row.targetKey === where ||
            idOf(row.targetKey) === where ||
            row.id === `framework:${where}`
    )
    if (byKey.length > 0) return byKey
    const byLabel = rows.filter((row) => row.targetLabel === where)
    const keys = [...new Set(byLabel.map((row) => row.targetKey))]
    if (keys.length > 1)
        throw new UsageError(
            `${keys.length} places are named "${where}" (${keys.map(idOf).join(', ')}); pass the id`
        )
    if (byLabel.length > 0) return byLabel
    // Nothing pending there is an answer only when the place exists; a source
    // that did not load may be where it lives, so then it is no answer at all.
    if (
        complete &&
        !knownPlaces(inputs).some(
            (place) => place.id === where || place.name === where
        )
    )
        throw new UsageError(
            `nothing named "${where}"; mf updates list shows where updates are`
        )
    return []
}

export const filterUpdates = (
    rows: UpdateRow[],
    inputs: UpdateCenterInputs,
    filter: UpdateFilter,
    complete: boolean
): UpdateRow[] => {
    const ofKind = filter.kind
        ? filterRowsByKind(rows, parseKindParam(filter.kind))
        : rows
    return filter.where
        ? narrowToPlace(ofKind, inputs, filter.where, complete)
        : ofKind
}
