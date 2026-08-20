import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelStatus,
    UpdateChannelBody
} from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit } from '@/output'
import {
    maskSensitive,
    parseJsonArg,
    printChannel,
    type RootChannelOptions
} from './helpers'

interface UpdateOptions {
    label?: string
    status?: ChannelStatus
    config?: string
    credentials?: string
    json?: boolean
}

export const registerChannelsUpdate = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('update <channelId>')
        .description('Patch a channel')
        .option('--label <label>', 'rename channel (1-200 chars)')
        .option(
            '--status <status>',
            'set channel status (draft|active|paused|error)'
        )
        .option('--config <json>', 'new channel config (@path or inline JSON)')
        .option(
            '--credentials <json>',
            'new channel credentials (@path or inline JSON)'
        )
        .option('--json', 'output the result as JSON', false)
        .action(async (channelId: string, opts: UpdateOptions) => {
            const root = program.opts<RootChannelOptions>()
            const body: UpdateChannelBody = {}
            if (opts.label !== undefined) body.label = opts.label
            if (opts.status !== undefined) body.status = opts.status
            if (opts.config !== undefined)
                body.config = (await parseJsonArg(
                    opts.config,
                    '--config'
                )) as ChannelConfig
            if (opts.credentials !== undefined)
                body.credentials = (await parseJsonArg(
                    opts.credentials,
                    '--credentials'
                )) as ChannelCredentials
            if (Object.keys(body).length === 0)
                throw new Error(
                    'pass at least one of --label, --status, --config, --credentials'
                )
            const { client } = await buildClient(root)
            const updated = await client.channels.update(channelId, body)
            emit(opts, maskSensitive(updated), () => {
                printChannel(updated)
                console.error(kleur.green(`✓ Updated channel ${updated.id}`))
            })
        })
}
