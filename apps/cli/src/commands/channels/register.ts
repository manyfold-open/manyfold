import type { Command } from 'commander'
import { buildClient } from '@/client'
import { type RootChannelOptions } from './helpers'

export const registerChannelsRegister = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('register <channelId>')
        .description(
            'Run provider-side registration (e.g. webhook setup) for a channel'
        )
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (channelId: string, _opts: { json?: boolean }) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const result = await client.channels.register(channelId)
            console.log(JSON.stringify(result, null, 2))
        })
}
