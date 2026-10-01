import { Option, type Command } from 'commander'
import { UPDATE_KINDS, buildUpdateRows, kindParamOf } from '@manyfold/shared'
import { buildClient } from '@/client'
import { refuseStrayWords } from '@/default-command'
import { emit, jsonOption } from '@/output'
import { resolveHttpTimeoutMs } from '@/transport'
import {
    applyUpdates,
    defaultApplyDeps,
    type ApplyDeps,
    type ApplyOptions
} from './apply'
import { filterUpdates } from './filter'
import { frameworkLabel, loadUpdateCenter, warnLoadErrors } from './load'
import { formatUpdates, jsonUpdate } from './render'
import { showVersions } from './versions'

interface GlobalOpts {
    apiUrl?: string
    token?: string
    account?: boolean
}

interface ListOpts {
    kind?: string
    where?: string
    json?: boolean
}

// The server holds an update request open until it has seen it through:
// up to three minutes for a computer, longer for a sandbox's CLI.
const UPDATE_REQUEST_TIMEOUT_MS = 5 * 60_000

const kindOption = (): Option =>
    new Option('--kind <kind>', 'only this kind of update').choices(
        UPDATE_KINDS.map(kindParamOf)
    )

const WHERE_HELP =
    'only updates on this computer, sandbox, cloud computer, runtime or agent'

const emptyText = (opts: ListOpts, partial: boolean): string => {
    if (opts.kind || opts.where)
        return `No ${opts.kind ? `${opts.kind} ` : ''}updates${opts.where ? ` on ${opts.where}` : ''}.`
    return partial ? 'No updates in what loaded.' : 'Everything is up to date.'
}

export const registerUpdates = (
    program: Command,
    deps: () => ApplyDeps = defaultApplyDeps
): void => {
    const group = program
        .command('updates')
        .description(
            "Pending updates on your computers, sandboxes, frameworks and skills, as in the web's Update Center"
        )

    const list = jsonOption(
        group
            .command('list', { isDefault: true })
            .alias('ls')
            .description('List pending updates and what each one needs')
            .addOption(kindOption())
            .option('--where <name|id>', WHERE_HELP)
    )
    list.action(async (opts: ListOpts) => {
        refuseStrayWords(list)
        const { client } = await buildClient(program.opts<GlobalOpts>())
        const { inputs, errors } = await loadUpdateCenter(client)
        const rows = filterUpdates(
            buildUpdateRows(inputs, frameworkLabel),
            inputs,
            opts,
            errors.length === 0
        )
        emit(opts, { updates: rows.map(jsonUpdate), errors }, () => {
            warnLoadErrors(errors)
            console.log(formatUpdates(rows, emptyText(opts, errors.length > 0)))
        })
    })

    const apply = jsonOption(
        group
            .command('apply [ids...]')
            .description(
                'Run pending updates: the ids given, or every one that can run from here'
            )
            .addOption(kindOption())
            .option('--where <name|id>', WHERE_HELP)
            .option('--to <version>', 'the version to go to, for one update')
            .option('-y, --yes', 'skip the confirmation prompt', false)
    )
    apply.action(async (ids: string[], opts: ApplyOptions) => {
        const { client } = await buildClient({
            ...program.opts<GlobalOpts>(),
            timeoutMs: Math.max(
                resolveHttpTimeoutMs(),
                UPDATE_REQUEST_TIMEOUT_MS
            )
        })
        await applyUpdates(client, ids, opts, deps())
    })

    const versions = jsonOption(
        group
            .command('versions [name]')
            .description(
                'Versions you can install, newest first: cli for the mf CLI or a framework name; without one, the latest of each'
            )
    )
    versions.action(async (name: string | undefined, opts: { json?: boolean }) => {
        const { client } = await buildClient(program.opts<GlobalOpts>())
        await showVersions(client, name, opts)
    })
}
