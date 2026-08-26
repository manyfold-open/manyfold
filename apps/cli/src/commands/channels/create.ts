import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    ChannelConfig,
    ChannelCredentials,
    ChannelProviderName,
    CreateChannelBody
} from '@manyfold/shared'
import { resolveAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { emit } from '@/output'
import {
    maskSensitive,
    parseJsonArg,
    printChannel,
    type RootChannelOptions
} from './helpers'

interface CreateOptions {
    agentId?: string
    provider: ChannelProviderName
    label: string
    config: string
    credentials?: string
    json?: boolean
}

export const registerChannelsCreate = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('create')
        .description('Create a channel')
        .option(
            '--agent-id <id>',
            'agent id (defaults to $MF_AGENT_ID or --agent-id global)'
        )
        .requiredOption(
            '--provider <name>',
            'channel provider (fake|lark|telegram|slack|discord|matrix|weixin|whatsapp|linear|github|line)'
        )
        .requiredOption('--label <label>', 'channel label (1-200 chars)')
        .requiredOption(
            '--config <json>',
            'channel config (@path for file, or inline JSON object)'
        )
        .option(
            '--credentials <json>',
            'channel credentials (@path for file, or inline JSON object)'
        )
        .option('--json', 'output the result as JSON', false)
        .action(async (opts: CreateOptions) => {
            const root = program.opts<RootChannelOptions>()
            const agentId = resolveAgentId(opts.agentId, program)
            const config = (await parseJsonArg(
                opts.config,
                '--config'
            )) as ChannelConfig
            const credentials = opts.credentials
                ? ((await parseJsonArg(
                      opts.credentials,
                      '--credentials'
                  )) as ChannelCredentials)
                : undefined
            const body: CreateChannelBody = {
                agentId,
                provider: opts.provider,
                label: opts.label,
                config,
                credentials
            }
            const { client } = await buildClient(root)
            const created = await client.channels.create(body)
            emit(opts, maskSensitive(created), () => {
                printChannel(created)
                console.error(kleur.green(`✓ Created channel ${created.id}`))
            })
        })
}
