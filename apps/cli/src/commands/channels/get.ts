import type { Command } from 'commander'
import { buildClient } from '@/client'
import { emit } from '@/output'
import {
    maskSensitive,
    printChannel,
    type RootChannelOptions
} from './helpers'

export const registerChannelsGet = (cmd: Command, program: Command): void => {
    cmd.command('get <channelId>')
        .description('Show a single channel')
        .option('--json', 'output the result as JSON', false)
        .action(async (channelId: string, opts: { json?: boolean }) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const channel = await client.channels.get(channelId)
            emit(opts, maskSensitive(channel), () => printChannel(channel))
        })
}
