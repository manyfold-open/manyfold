import type { Command } from 'commander'
import { buildClient } from '@/client'
import { emit } from '@/output'

export const registerUi = (program: Command): void => {
    program
        .command('ui')
        .description('Resolve platform resources to Manyfold web pages')
        .command('resolve <resource> [id]')
        .description(
            'Resolve an automation or the automations list to a web URL'
        )
        .option(
            '--run-id <id>',
            'resolve the conversation of this automation run'
        )
        .option('--json', 'output resource links as JSON', false)
        .action(
            async (
                resource: string,
                id: string | undefined,
                opts: { runId?: string; json: boolean }
            ) => {
                if (resource !== 'automation')
                    throw new Error('resource must be automation')
                if (opts.runId && !id)
                    throw new Error('--run-id requires an automation id')
                const { client } = await buildClient(program.opts())
                const link = await client.automations.ui(id)
                if (!opts.runId) {
                    emit(opts, link, () => console.log(link.url))
                    return
                }
                const run = link.runs?.find(
                    (entry) => entry.runId === opts.runId
                )
                if (!run)
                    throw new Error(
                        'run has no available conversation in the recent run history'
                    )
                emit(
                    opts,
                    {
                        ...link,
                        url: run.url,
                        runId: run.runId,
                        sessionId: run.sessionId
                    },
                    () => console.log(run.url)
                )
            }
        )
}
