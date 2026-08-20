import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit } from '@/output'
import { type RootChannelOptions } from './helpers'

export const registerChannelsDelete = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('delete <channelId>')
        .alias('rm')
        .description('Delete a channel')
        .option('--json', 'output the result as JSON', false)
        .action(async (channelId: string, opts: { json?: boolean }) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            await client.channels.delete(channelId)
            emit(opts, { ok: true, id: channelId }, () =>
                console.error(kleur.green(`✓ Deleted channel ${channelId}`))
            )
        })
}
