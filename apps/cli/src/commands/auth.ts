import type { Command } from 'commander'
import kleur from 'kleur'
import {
    grantableScopes,
    isGrantableScope,
    type GrantableScope,
    type RequestPermissionResponse
} from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit } from '@/output'

interface AuthEnsureOptions {
    scopes?: string
    forAgent?: string
    json?: boolean
}

interface RootOptions {
    apiUrl?: string
    token?: string
    agentId?: string
}

interface PermissionEnsureResult {
    agentId: string
    response: RequestPermissionResponse
}

export const parseRequestedScopes = (csv: string): GrantableScope[] => {
    const seen = new Set<GrantableScope>()
    const out: GrantableScope[] = []
    for (const part of csv.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        if (!isGrantableScope(trimmed))
            throw new Error(
                `unknown grant scope: ${trimmed}\n` +
                    `valid scopes: ${grantableScopes.join(', ')}`
            )
        if (seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    if (out.length === 0)
        throw new Error('--scopes must list at least one grant scope')
    return out
}

export const ensurePermissionScopes = async (
    root: RootOptions,
    opts: AuthEnsureOptions
): Promise<PermissionEnsureResult> => {
    if (!opts.scopes) throw new Error('--scopes <list> is required')
    const scopes = parseRequestedScopes(opts.scopes)
    const agentId = opts.forAgent ?? root.agentId ?? process.env.MF_AGENT_ID
    if (!agentId)
        throw new Error(
            'no agent id: pass --for-agent <id>, --agent-id <id>, or run inside a managed runtime where $MF_AGENT_ID is set'
        )
    const { client } = await buildClient(root)
    const response = await client.agents.requestPermission(agentId, {
        scopes
    })
    return { agentId, response }
}

export const printPermissionEnsureResult = (
    result: PermissionEnsureResult
): void => {
    console.log(
        kleur.bold('Authorization approval required') +
            kleur.dim(
                ` (agent: ${result.agentId}, scopes: ${result.response.scopes.join(', ')})`
            )
    )
    console.log(`Consent URL: ${kleur.cyan(result.response.consentUrl)}`)
    console.log(
        'Post exactly that URL to the user and ask them to approve. ' +
            'Existing permissions are kept — this only adds the requested scopes.'
    )
}

export const registerAuth = (program: Command): void => {
    const auth = program
        .command('auth')
        .description('Authenticate and manage capabilities for the current identity')

    auth.command('ensure')
        .description('Ensure the current identity has the requested capabilities')
        .option(
            '--scopes <list>',
            'comma-separated grant scopes to ensure (e.g. channels:read,channels:edit)'
        )
        .option(
            '--for-agent <id>',
            'agent to ensure scopes for (defaults to --agent-id / $MF_AGENT_ID)'
        )
        .option('--json', 'output the result as JSON', false)
        .action(async (opts: AuthEnsureOptions) => {
            const root = program.opts<RootOptions>()
            const result = await ensurePermissionScopes(root, opts)
            emit(
                opts,
                { agentId: result.agentId, ...result.response },
                () => printPermissionEnsureResult(result)
            )
        })
}
