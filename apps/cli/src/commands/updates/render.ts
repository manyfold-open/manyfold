import kleur from 'kleur'
import {
    FRAMEWORK_INSTALL_GUIDES,
    blockerStatus,
    isRunnableUpdate,
    kindParamOf,
    type UpdateRow,
    type UpdateStatus
} from '@manyfold/shared'
import { formatTable, type TableCell } from '@/table'

type Styled = readonly [text: string, style: (text: string) => string]

const STATUS_TEXT: Record<UpdateStatus, string> = {
    ready: 'ready',
    required: 'required',
    manual: 'by hand',
    offline: 'offline'
}

// Where a row is stuck is the label; how urgent it is rides along in words,
// because a terminal without color shows no tone.
export const statusCell = (row: UpdateRow): Styled => {
    if (row.materialization?.status === 'installing')
        return ['installing', kleur.yellow]
    if (row.materialization?.status === 'failed') return ['failed', kleur.red]
    const status = blockerStatus(row)
    const urgent = row.severity === 'required'
    const text =
        urgent && status !== 'required'
            ? `${STATUS_TEXT[status]}, required`
            : STATUS_TEXT[status]
    return [
        text,
        urgent || status === 'offline'
            ? kleur.red
            : status === 'manual'
              ? kleur.dim
              : kleur.cyan
    ]
}

// What a person can do about a row the platform cannot run from here.
export const rowGuidance = (row: UpdateRow): string | null => {
    if (row.blocker === 'offline')
        return row.targetKind === 'k8s'
            ? `${row.targetLabel} is not ready or its daemon is offline; try again once it is up`
            : `${row.targetLabel} is offline: start its daemon there (mf daemon start), then run this again`
    if (row.exec.type !== 'none') return null
    if (row.kind === 'cli')
        return `on ${row.targetLabel}: mf update, then restart its daemon (mf daemon stop && mf daemon start)`
    if (row.exec.guideFramework) {
        const guide = FRAMEWORK_INSTALL_GUIDES[row.exec.guideFramework]
        return guide
            ? `on ${row.targetLabel}: ${guide.upgrade}`
            : `update ${row.subjectLabel} on ${row.targetLabel} by hand`
    }
    return `update it from the runtime's settings in the web app (${row.targetLabel})`
}

const rowDetails = (row: UpdateRow): Styled[] => {
    const lines: Styled[] = []
    if (row.blockedReason) lines.push([row.blockedReason, kleur.red])
    if (row.materialization?.status === 'failed')
        lines.push([
            `last install failed${row.materialization.error ? `: ${row.materialization.error}` : ''}`,
            kleur.red
        ])
    if (row.materialization?.status === 'installing')
        lines.push([
            'installing; mf updates list shows when it is done',
            kleur.dim
        ])
    const guidance = rowGuidance(row)
    if (guidance) lines.push([guidance, kleur.dim])
    return lines
}

const updatesCount = (n: number): string =>
    `${n} ${n === 1 ? 'update' : 'updates'}`

export const formatUpdates = (rows: UpdateRow[], emptyText: string): string => {
    if (rows.length === 0) return emptyText
    const [header, ...lines] = formatTable(
        ['KIND', 'SUBJECT', 'WHERE', 'FROM', 'TO', 'STATUS'],
        rows.map((row): TableCell[] => [
            kindParamOf(row.kind),
            [row.subjectLabel, kleur.cyan],
            row.targetLabel,
            [row.installedVersion ?? 'unknown', kleur.dim],
            row.latestVersion ?? '—',
            statusCell(row)
        ])
    )
    const out = [header]
    rows.forEach((row, index) => {
        out.push(lines[index])
        for (const [text, style] of rowDetails(row)) out.push(style(`  ${text}`))
    })
    const runnable = rows.filter(isRunnableUpdate).length
    out.push(
        kleur.dim(
            runnable > 0
                ? `${updatesCount(rows.length)}, ${runnable} can run from here: mf updates apply`
                : `${updatesCount(rows.length)}, none can run from here`
        )
    )
    return out.join('\n')
}

export type JsonUpdate = UpdateRow & {
    status: UpdateStatus
    runnable: boolean
    guidance: string | null
}

export const jsonUpdate = (row: UpdateRow): JsonUpdate => ({
    ...row,
    status: blockerStatus(row),
    runnable: isRunnableUpdate(row),
    guidance: rowGuidance(row)
})
