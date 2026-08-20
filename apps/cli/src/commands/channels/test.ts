import type { Command } from 'commander'
import { buildClient } from '@/client'
import { type RootChannelOptions } from './helpers'

export const registerChannelsTest = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('test <channelId>')
        .description('Run a connectivity test for a channel')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (channelId: string, _opts: { json?: boolean }) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const result = await client.channels.test(channelId)
            console.log(JSON.stringify(result, null, 2))
        })
}
