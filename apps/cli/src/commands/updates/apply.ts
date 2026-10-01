import kleur from 'kleur'
import type { NcaClient } from '@manyfold/sdk'
import {
    blockerStatus,
    buildUpdateRows,
    isRunnableUpdate,
    kindParamOf,
    planBatch,
    type UpdateRow
} from '@manyfold/shared'
import { printJson } from '@/output'
import { promptYesNo } from '@/prompt'
import { UsageError } from '@/usage-error'
import { filterUpdates, type UpdateFilter } from './filter'
import {
    frameworkLabel,
    loadUpdateCenter,
    warnLoadErrors,
    type SourceError
} from './load'
import { rowGuidance, statusCell } from './render'
import {
    realTimers,
    runUpdateSteps,
    type RowOutcome,
    type RunEvent,
    type UpdateTimers
} from './run'

export interface ApplyOptions extends UpdateFilter {
    to?: string
    yes?: boolean
    json?: boolean
}

export interface ApplyDeps {
    timers: UpdateTimers
    interactive: () => boolean
    confirm: (question: string) => Promise<boolean>
}

export const defaultApplyDeps = (): ApplyDeps => ({
    timers: realTimers,
    interactive: () => Boolean(process.stdin.isTTY),
    confirm: promptYesNo
})

const label = (row: UpdateRow): string =>
    `${row.subjectLabel} · ${row.targetLabel}`

const catalogMissing = (row: UpdateRow, errors: SourceError[]): boolean =>
    errors.some((error) =>
        row.kind === 'framework'
            ? error.source === 'frameworkCatalog'
            : row.kind === 'cli' && error.source === 'cliVersions'
    )

const pick = (
    rows: UpdateRow[],
    ids: string[]
): { selected: UpdateRow[]; skipped: UpdateRow[] } => {
    const selected: UpdateRow[] = []
    for (const id of [...new Set(ids)]) {
        const row = rows.find((candidate) => candidate.id === id)
        if (!row)
            throw new UsageError(
                `no pending update ${id}; mf updates list --json shows the ids`
            )
        if (!isRunnableUpdate(row))
            throw new UsageError(
                `${id} cannot run from here (${statusCell(row)[0]})${rowGuidance(row) ? `: ${rowGuidance(row)}` : ''}`
            )
        selected.push(row)
    }
    return { selected, skipped: [] }
}

const targetsFor = (
    selected: UpdateRow[],
    to: string | undefined,
    errors: SourceError[]
): Record<string, string> => {
    if (to === undefined) return {}
    if (selected.length !== 1)
        throw new UsageError(
            `--to needs exactly one update; this selects ${selected.length}`
        )
    const [row] = selected
    if (row.targetChoices.length === 0)
        throw new UsageError(
            `${row.id} offers no versions to choose from${catalogMissing(row, errors) ? ' (its version list did not load)' : ''}`
        )
    if (!row.targetChoices.includes(to))
        throw new UsageError(
            `${row.id} cannot go to ${to}; pick one of ${row.targetChoices.slice(0, 8).join(', ')}`
        )
    return { [row.id]: to }
}

const progress = (rows: Map<string, UpdateRow>) => (event: RunEvent): void => {
    const names = event.type === 'done' ? [] : event.rowIds.map((id) => rows.get(id))
    if (event.type === 'start')
        console.error(
            kleur.dim(
                `updating ${names.map((row) => (row ? label(row) : '')).join(', ')}…`
            )
        )
    if (event.type === 'waiting')
        console.error(
            kleur.dim(
                `  waiting ${Math.ceil(event.ms / 1000)}s: the API takes 5 computer updates a minute`
            )
        )
    if (event.type === 'phase') console.error(kleur.dim(`  ${event.phase}`))
}

const resultLine = (
    row: UpdateRow,
    to: string | null,
    outcome: RowOutcome
): string => {
    if (outcome.state === 'updated')
        return `${kleur.green('✓')} ${label(row)}  ${kleur.dim(row.installedVersion ?? 'unknown')} → ${to ?? 'latest'}`
    if (outcome.state === 'pending')
        return `${kleur.yellow('…')} ${label(row)}  ${outcome.message}`
    return `${kleur.red('✗')} ${label(row)}  ${outcome.message}`
}

const skippedJson = (
    row: UpdateRow
): { id: string; status: string; guidance: string | null } => ({
    id: row.id,
    status: blockerStatus(row),
    guidance: rowGuidance(row)
})

export const applyUpdates = async (
    client: NcaClient,
    ids: string[],
    opts: ApplyOptions,
    deps: ApplyDeps
): Promise<void> => {
    if (ids.length > 0 && (opts.kind || opts.where))
        throw new UsageError('pass update ids or --kind/--where, not both')
    if (opts.json && !opts.yes)
        throw new UsageError('--json never prompts; pass --yes to apply')
    if (!opts.yes && !deps.interactive())
        throw new UsageError(
            'non-interactive shell; pass --yes to apply updates'
        )

    const { inputs, errors } = await loadUpdateCenter(client)
    const rows = buildUpdateRows(inputs, frameworkLabel)
    const { selected, skipped } =
        ids.length > 0
            ? pick(rows, ids)
            : (() => {
                  const matched = filterUpdates(
                      rows,
                      inputs,
                      opts,
                      errors.length === 0
                  )
                  return {
                      selected: matched.filter(isRunnableUpdate),
                      skipped: matched.filter((row) => !isRunnableUpdate(row))
                  }
              })()
    const targets = targetsFor(selected, opts.to, errors)
    const toOf = (row: UpdateRow): string | null =>
        targets[row.id] ?? row.latestVersion

    if (!opts.json) warnLoadErrors(errors)
    if (selected.length === 0) {
        if (opts.json)
            printJson({
                results: [],
                skipped: skipped.map(skippedJson),
                summary: { updated: 0, pending: 0, failed: 0 },
                errors
            })
        else
            console.log(
                skipped.length > 0
                    ? `Nothing can run from here; mf updates list says why for ${skipped.length}.`
                    : 'Nothing to update.'
            )
        return
    }

    if (!opts.yes) {
        console.log(`Updates to run (${selected.length}):`)
        for (const row of selected)
            console.log(
                `  ${label(row)}  ${kleur.dim(row.installedVersion ?? 'unknown')} → ${toOf(row) ?? 'latest'}`
            )
        if (skipped.length > 0)
            console.log(
                kleur.dim(
                    `Skipped ${skipped.length} that cannot run from here; mf updates list says why.`
                )
            )
        if (!(await deps.confirm(`Apply ${selected.length} ${selected.length === 1 ? 'update' : 'updates'}? [Y/n] `))) {
            console.log(kleur.dim('cancelled.'))
            return
        }
    }

    const byId = new Map(rows.map((row) => [row.id, row]))
    const report = progress(byId)
    const outcomes = await runUpdateSteps(
        client,
        planBatch(selected, targets),
        byId,
        {
            timers: deps.timers,
            onEvent: opts.json
                ? undefined
                : (event): void => {
                      if (event.type !== 'done') return report(event)
                      const row = byId.get(event.rowId)
                      if (row)
                          console.log(resultLine(row, toOf(row), event.outcome))
                  }
        }
    )
    const results = selected.map((row) => {
        const outcome: RowOutcome = outcomes.get(row.id) ?? {
            state: 'failed',
            code: 'cli_error',
            message: 'did not run'
        }
        return {
            id: row.id,
            kind: kindParamOf(row.kind),
            subject: row.subjectLabel,
            where: row.targetLabel,
            from: row.installedVersion,
            to: toOf(row),
            ...outcome
        }
    })
    const summary = {
        updated: results.filter((result) => result.state === 'updated').length,
        pending: results.filter((result) => result.state === 'pending').length,
        failed: results.filter((result) => result.state === 'failed').length
    }
    if (opts.json)
        printJson({ results, skipped: skipped.map(skippedJson), summary, errors })
    else
        console.log(
            `${summary.updated} updated · ${summary.pending} pending · ${summary.failed} failed`
        )
    if (summary.failed > 0) process.exitCode = 1
}
