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
    modelChoices,
    type CreateFramework
} from '@/commands/agent/create-source'

type ProviderRow = UserModelProviderSummary & {
    // With --framework: whether it can serve that framework, and the models
    // `mf agent create --model` accepts from it (null: any the framework
    // itself knows, which no provider test lists).
    verdict?: ProviderRowVerdict
    models?: string[] | null
}

const VERDICT_LABELS: Record<ProviderRowVerdict, string> = {
    usable: 'usable',
    untested: 'not tested yet',
    incompatible: 'cannot serve it'
}

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
            `${row.id}  ${kleur.cyan(row.providerName)}  ${row.source === 'managed' ? 'managed' : 'saved'}  ${status}${notes.length ? kleur.dim(`  (${notes.join('; ')})`) : ''}`
        )
        if (row.verdict === 'usable' && row.models?.length)
            lines.push(kleur.dim(`  models: ${row.models.join(', ')}`))
    }
    if (framework && rows.some((row) => row.verdict === 'untested'))
        lines.push(
            kleur.dim(
                'A provider not tested yet has no models to run: test it under Settings → Model providers in the web app.'
            )
        )
    return lines.join('\n')
}

export const registerModelProviders = (program: Command): void => {
    const group = program
        .command('model-providers')
        .description('List the model providers agents can be created with')
    jsonOption(
        group
            .command('list')
            .alias('ls')
            .description(
                'List your saved and Manyfold managed model providers; --framework checks each against a framework'
            )
            .addOption(
                new Option(
                    '--framework <framework>',
                    'coding framework to check each provider against'
                ).choices(CREATE_FRAMEWORKS)
            )
    ).action(
        async (options: { json?: boolean; framework?: CreateFramework }) => {
            const global = program.opts<{
                apiUrl?: string
                token?: string
                account?: boolean
            }>()
            const { client } = await buildClient(global)
            const providers = await client.modelProviders.list()
            const framework = options.framework ?? null
            const managed = framework
                ? (managedChannelFor(framework, providers)?.id ?? null)
                : null
            const rows: ProviderRow[] = providers.map((row) => {
                if (!framework) return row
                const verdict = providerRowVerdict(framework, row)
                return {
                    ...row,
                    verdict,
                    models:
                        verdict === 'usable' ? modelChoices(framework, row) : []
                }
            })
            emit(options, { framework, managed, providers: rows }, () =>
                console.log(formatModelProviders(rows, framework, managed))
            )
        }
    )
}
