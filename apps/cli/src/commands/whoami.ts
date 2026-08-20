import type { Command } from 'commander'
import kleur from 'kleur'
import type { AuthWhoamiResponse, UserRole } from '@manyfold/shared'
import { buildClient } from '@/client'
import {
    resolveConfigPath,
    resolveProfile,
    resolveProfileSource
} from '@/config'
import { emit, fail, jsonOption } from '@/output'

type WhoamiView =
    | AuthWhoamiResponse
    | {
          kind: 'legacy-auth-me'
          userId: string
          email: string
          role: UserRole
      }

export const registerWhoami = (program: Command): void => {
    jsonOption(
        program
            .command('whoami')
            .description('Print the currently authenticated user')
    ).action(async (opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string }>()
        const { client } = await buildClient(global)
        try {
            const user = await loadWhoami(client)
            emit(opts, user, () => {
                console.log(formatWhoami(user))
                // ADR-0014 visibility: which profile answered. Human tail
                // only — the --json payload stays the pure API response
                // (`mf profile show --json` is the structured source).
                console.log(
                    kleur.dim(
                        `profile: ${resolveProfile()} (${resolveProfileSource()}) · ${resolveConfigPath()}`
                    )
                )
            })
        } catch (error) {
            fail(opts, error)
        }
    })
}

const loadWhoami = async (
    client: Awaited<ReturnType<typeof buildClient>>['client']
): Promise<WhoamiView> => {
    try {
        return await client.auth.whoami()
    } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error
        const user = await client.auth.me()
        return {
            kind: 'legacy-auth-me',
            userId: user.id,
            email: user.email,
            role: user.role
        }
    }
}

export const formatWhoami = (user: WhoamiView): string => {
    if (user.kind === 'agent-runtime')
        return `${kleur.green('Signed in as agent')} ${user.agentId} ${kleur.dim(`(${user.userId}, runtime identity)`)}`
    if (user.kind === 'legacy-runtime')
        return `${kleur.green('Signed in as agent grant')} ${user.agentId} ${kleur.dim(`(${user.email || user.userId}, ${user.role})`)}`
    return `${kleur.green('Signed in as')} ${user.email || user.userId} ${kleur.dim(`(${user.userId}, ${user.role})`)}`
}
