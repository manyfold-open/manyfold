import kleur from 'kleur'
import type { NcaClient } from '@manyfold/sdk'
import {
    frameworkCatalogVersions,
    type CliVersionCatalog,
    type FrameworkVersionCatalogEntry
} from '@manyfold/shared'
import { emit } from '@/output'
import { formatTable, type TableCell } from '@/table'
import { UsageError } from '@/usage-error'
import { MF_CLI_VERSION } from '@/version'
import { settle, sourceError, warnLoadErrors, type SourceError } from './load'

interface JsonOpts {
    json?: boolean
}

const sourceText = (entry: FrameworkVersionCatalogEntry): string =>
    entry.sourceRepo ? `${entry.source} ${entry.sourceRepo}` : entry.source

const noteCell = (...notes: Array<string | null>): string =>
    notes.filter(Boolean).join(', ')

const showSummary = async (client: NcaClient, opts: JsonOpts): Promise<void> => {
    const [cli, frameworks] = await Promise.all([
        settle(() => client.cliVersions.list()),
        settle(() => client.frameworkVersions.list())
    ])
    if (!cli.ok && !frameworks.ok) throw cli.error
    const errors: SourceError[] = []
    if (!cli.ok) errors.push(sourceError('cliVersions', cli.error))
    if (!frameworks.ok)
        errors.push(sourceError('frameworkCatalog', frameworks.error))
    const payload = {
        cli: cli.ok
            ? { stable: cli.value.stable[0] ?? null, dev: cli.value.dev[0] ?? null }
            : null,
        frameworks: frameworks.ok
            ? frameworks.value.map(
                  ({ framework, latest, source, sourceRepo, fetchedAt }) => ({
                      framework,
                      latest,
                      source,
                      sourceRepo,
                      fetchedAt
                  })
              )
            : [],
        errors
    }
    emit(opts, payload, () => {
        warnLoadErrors(errors)
        const rows: TableCell[][] = []
        if (payload.cli) {
            rows.push(['cli', payload.cli.stable ?? '—', 'stable'])
            if (payload.cli.dev) rows.push(['cli', payload.cli.dev, 'dev'])
        }
        if (frameworks.ok)
            for (const entry of frameworks.value)
                rows.push([entry.framework, entry.latest ?? '—', sourceText(entry)])
        for (const line of formatTable(['NAME', 'LATEST', 'SOURCE'], rows))
            console.log(line)
        console.log(kleur.dim('mf updates versions <name> lists every version.'))
    })
}

const showCli = (catalog: CliVersionCatalog, opts: JsonOpts): void =>
    emit(opts, { ...catalog, installed: MF_CLI_VERSION }, () => {
        const rows = (['stable', 'dev'] as const).flatMap((channel) =>
            catalog[channel].map((version, index): TableCell[] => [
                version,
                channel,
                noteCell(
                    index === 0 ? 'latest' : null,
                    version === MF_CLI_VERSION ? 'installed' : null
                )
            ])
        )
        if (rows.length === 0) {
            console.log('No mf CLI versions listed.')
            return
        }
        for (const line of formatTable(['VERSION', 'CHANNEL', 'NOTE'], rows))
            console.log(line)
        console.log(
            kleur.dim(
                'Install one here with mf update --to <version>; on a sandbox, mf sandbox update <sandbox> --to <version>.'
            )
        )
    })

const showFramework = (
    entry: FrameworkVersionCatalogEntry,
    opts: JsonOpts
): void =>
    emit(opts, entry, () => {
        console.log(
            `${entry.framework}: ${sourceText(entry)}, ${entry.fetchedAt ? `fetched ${entry.fetchedAt}` : 'not fetched yet'}`
        )
        const versions = frameworkCatalogVersions(entry)
        if (versions.length === 0) console.log('No versions listed.')
        else
            for (const line of formatTable(
                ['VERSION', 'NOTE'],
                versions.map((version): TableCell[] => [
                    version,
                    version === entry.latest ? 'latest' : ''
                ])
            ))
                console.log(line)
        if (entry.blocked.length > 0)
            for (const line of formatTable(
                ['BLOCKED', 'REASON'],
                entry.blocked.map(({ min, max, reason }): TableCell[] => [
                    [min === max ? min : `${min}–${max}`, kleur.red],
                    reason
                ])
            ))
                console.log(line)
    })

export const showVersions = async (
    client: NcaClient,
    catalog: string | undefined,
    opts: JsonOpts
): Promise<void> => {
    if (catalog === undefined) return showSummary(client, opts)
    if (catalog === 'cli') return showCli(await client.cliVersions.list(), opts)
    // The API's own list, not this CLI's framework registry: a deployment's
    // edition can register frameworks the open-source CLI has never heard of.
    const entries = await client.frameworkVersions.list()
    const entry = entries.find((candidate) => candidate.framework === catalog)
    if (!entry)
        throw new UsageError(
            `unknown version list "${catalog}"; pick cli or one of ${entries.map((candidate) => candidate.framework).join(', ')}`
        )
    showFramework(entry, opts)
}
