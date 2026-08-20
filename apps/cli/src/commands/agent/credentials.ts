import type { Command } from 'commander'
import kleur from 'kleur'
import type { UpdateAgentCredentialsBody } from '@manyfold/shared'
import { buildClient } from '@/client'
import { parseJsonArg } from '@/commands/channels/helpers'

interface GetOptions {
    json?: boolean
}

interface RevealOptions {
    json?: boolean
    show?: boolean
}

interface UpdateOptions {
    body: string
    json?: boolean
}

export const registerAgentCredentials = (
    cmd: Command,
    program: Command
): void => {
    const cred = cmd
        .command('credentials')
        .description('Manage agent credentials (provider keys, etc.)')

    cred.command('get <agentId>')
        .description('Show credential metadata (not secrets)')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (agentId: string, _opts: GetOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const view = await client.agents.credentials.get(agentId)
            console.log(JSON.stringify(view, null, 2))
        })

    cred.command('reveal <agentId>')
        .description(
            'Reveal credentials. Output is masked unless --show is passed.'
        )
        .option('--json', 'emit raw JSON', false)
        .option('--show', 'print the secret in plaintext', false)
        .action(async (agentId: string, opts: RevealOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agents.credentials.reveal(agentId)
            const display = opts.show
                ? res
                : { ...res, apiKey: maskSecret(res.apiKey) }
            if (opts.json) {
                console.log(JSON.stringify(display, null, 2))
                return
            }
            console.log(`agentId=${agentId}`)
            console.log(`apiKey=${display.apiKey}`)
            if (!opts.show)
                console.log(
                    kleur.dim('(use --show to print the plaintext value)')
                )
        })

    cred.command('update <agentId>')
        .description('Update agent credentials')
        .requiredOption(
            '--body <json>',
            'request body JSON (or @file). Shape: UpdateAgentCredentialsBody'
        )
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: UpdateOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const body = (await parseJsonArg(
                opts.body,
                '--body'
            )) as UpdateAgentCredentialsBody
            const view = await client.agents.credentials.update(agentId, body)
            if (opts.json) {
                console.log(JSON.stringify(view, null, 2))
                return
            }
            console.log(
                `${kleur.dim('✓ updated credentials for')} ${agentId}`
            )
        })
}

const maskSecret = (value: string): string => {
    if (!value) return ''
    if (value.length <= 8) return '***'
    return `${value.slice(0, 4)}…${value.slice(-4)}`
}
