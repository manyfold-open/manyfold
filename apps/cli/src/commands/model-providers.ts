import { Option, type Command } from 'commander'
import kleur from 'kleur'
import {
    managedChannelFor,
    providerRowVerdict,
    type ProviderRowVerdict,
    type UserModelProviderSummary
} from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'
import {
    CREATE_FRAMEWORKS,
    formatModelOptions,
    modelOptionsFor,
    resolveProviderRef,
    UsageError,
    type CreateFramework,
    type ModelOption
} from '@/commands/agent/create-source'

type ProviderRow = UserModelProviderSummary & {
    // With --framework: whether it can serve that framework, and the models
    // `mf agent create --model` accepts from it (null: any name the framework
    // itself knows, which no provider test lists).
    verdict?: ProviderRowVerdict
    models?: ModelOption[] | null
}

const VERDICT_LABELS: Record<ProviderRowVerdict, string> = {
    usable: 'usable',
    untested: 'not tested yet',
    incompatible: 'cannot serve it'
}

const withVerdict = (
    row: UserModelProviderSummary,
    framework: CreateFramework
): ProviderRow => {
    const verdict = providerRowVerdict(framework, row)
    return {
        ...row,
        verdict,
        models: verdict === 'usable' ? modelOptionsFor(framework, row) : []
    }
}

const modelLines = (row: ProviderRow): string[] =>
    row.verdict === 'usable' && row.models?.length
        ? formatModelOptions(row.models).map((line) => kleur.dim(`  ${line}`))
        : []

const formatModelProviders = (
    rows: readonly ProviderRow[],
    framework: CreateFramework | null,
    managed: string | null
): string => {
    if (rows.length === 0)
        return kleur.dim(
            'No model providers yet: add one under Settings → Model providers in the web app.'
        )
    const lines: string[] = []
    for (const row of rows) {
        const status = row.verdict
            ? VERDICT_LABELS[row.verdict]
            : (row.lastTestStatus ?? 'not tested yet')
        const notes = [
            row.channelDisabled ? 'closed to new agents' : null,
            row.id === managed ? `what --model-provider managed picks` : null
        ].filter(Boolean)
        lines.push(
            `${row.id}  ${kleur.cyan(row.providerName)}  ${row.source === 'managed' ? 'managed' : 'saved'}  ${status}${notes.length ? kleur.dim(`  (${notes.join('; ')})`) : ''}`,
            ...modelLines(row)
        )
    }
    if (framework && rows.some((row) => row.verdict === 'untested'))
        lines.push(
            kleur.dim(
                'A provider not tested yet has no models to run: mf model-providers test <id|name> tests it.'
            )
        )
    if (framework === 'claude-code' && rows.some((row) => row.models?.length))
        lines.push(
            kleur.dim(
                "An alias (sonnet, opus, …) follows its family's newest tested model; an id pins one."
            )
        )
    return lines.join('\n')
}

const frameworkOption = (): Option =>
    new Option(
        '--framework <framework>',
        'coding framework to check each provider against'
    ).choices(CREATE_FRAMEWORKS)

export const registerModelProviders = (program: Command): void => {
    const group = program
        .command('model-providers')
        .description(
            'List and test the model providers agents can be created with'
        )
    const globalOpts = () =>
        program.opts<{
            apiUrl?: string
            token?: string
            account?: boolean
        }>()
    jsonOption(
        group
            .command('list')
            .alias('ls')
            .description(
                'List your saved and Manyfold managed model providers; --framework checks each against a framework'
            )
            .addOption(frameworkOption())
    ).action(
        async (options: { json?: boolean; framework?: CreateFramework }) => {
            const { client } = await buildClient(globalOpts())
            const providers = await client.modelProviders.list()
            const framework = options.framework ?? null
            const managed = framework
                ? (managedChannelFor(framework, providers)?.id ?? null)
                : null
            const rows: ProviderRow[] = framework
                ? providers.map((row) => withVerdict(row, framework))
                : providers
            emit(options, { framework, managed, providers: rows }, () =>
                console.log(formatModelProviders(rows, framework, managed))
            )
        }
    )
    const test = jsonOption(
        group
            .command('test <provider>')
            .description(
                'Test a provider again (id or name), which refreshes the models it can run'
            )
            .addOption(frameworkOption())
    )
    test.action(
        async (
            ref: string,
            options: { json?: boolean; framework?: CreateFramework }
        ) => {
            const { client } = await buildClient(globalOpts())
            let row: UserModelProviderSummary
            try {
                row = resolveProviderRef(
                    await client.modelProviders.list(),
                    ref
                )
            } catch (err) {
                if (err instanceof UsageError)
                    test.error(`error: ${err.message}`)
                throw err
            }
            const result = await client.modelProviders.test(row.id)
            const framework = options.framework ?? null
            // The test rewrites the row's model list; read it back so the
            // models shown are the ones `mf agent create --model` now takes.
            const tested =
                framework && result.ok
                    ? withVerdict(
                          resolveProviderRef(
                              await client.modelProviders.list(),
                              row.id
                          ),
                          framework
                      )
                    : null
            if (!result.ok) process.exitCode = 1
            emit(
                options,
                {
                    provider: { id: row.id, name: row.providerName },
                    result,
                    framework,
                    models: tested?.models ?? null
                },
                () => {
                    console.log(
                        result.ok
                            ? `${kleur.green('✓')} ${row.providerName}: ${result.models.length} model${result.models.length === 1 ? '' : 's'}  ${kleur.dim(`${result.latencyMs} ms`)}`
                            : `${kleur.red('✗')} ${row.providerName}: ${result.status}${result.message ? `: ${result.message}` : ''}`
                    )
                    if (!tested) return
                    if (tested.verdict !== 'usable')
                        console.log(
                            kleur.dim(
                                `  ${VERDICT_LABELS[tested.verdict ?? 'incompatible']} for ${framework}`
                            )
                        )
                    for (const line of modelLines(tested)) console.log(line)
                }
            )
        }
    )
}
