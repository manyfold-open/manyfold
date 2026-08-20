import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    AgentConnectionInfo,
    ConnectionProvider,
    UserConnectionSummary
} from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit, fail, jsonOption } from '@/output'

const PROVIDER_LABEL: Record<ConnectionProvider, string> = {
    github: 'GitHub',
    cloudflare: 'Cloudflare',
    composio: 'Composio'
}

const label = (provider: string): string =>
    PROVIDER_LABEL[provider as ConnectionProvider] ?? provider

export const registerConnections = (program: Command): void => {
    jsonOption(
        program
            .command('connections')
            .description(
                'List the connections linked to this agent (or, for a user, your account)'
            )
    ).action(async (opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string }>()
        const { client } = await buildClient(global)
        try {
            const who = await client.auth.whoami()
            if (who.kind === 'agent-runtime' || who.kind === 'legacy-runtime') {
                const { connections } = await client.agentSelf.connections()
                emit(opts, connections, () =>
                    console.log(formatAgentConnections(connections))
                )
                return
            }
            const list = await client.connections.list()
            emit(opts, list, () => console.log(formatUserConnections(list)))
        } catch (error) {
            fail(opts, error)
        }
    })
}

export const formatAgentConnections = (
    connections: AgentConnectionInfo[]
): string => {
    if (connections.length === 0)
        return kleur.dim('No connections are linked to this agent.')
    return connections
        .map((c) => {
            const account = c.account ? kleur.dim(` · ${c.account}`) : ''
            return `${kleur.green(label(c.provider))} ${c.displayName}${account}\n  ${kleur.dim(c.usage)}`
        })
        .join('\n\n')
}

const formatUserConnections = (list: UserConnectionSummary[]): string => {
    if (list.length === 0) return kleur.dim('No connections yet.')
    return list
        .map((c) => {
            const account = c.externalId ? kleur.dim(` · ${c.externalId}`) : ''
            return `${kleur.green(label(c.provider))} ${c.displayName}${account}`
        })
        .join('\n')
}
