import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { type RootChannelOptions } from './helpers'

interface ListOptions {
    scopeKey?: string
    includeArchived?: boolean
    json?: boolean
}

interface ScopesOptions {
    json?: boolean
}

interface NewOptions {
    scopeKey: string
    name?: string
    json?: boolean
}

interface SwitchOptions {
    json?: boolean
}

interface RenameOptions {
    json?: boolean
}

interface DeleteOptions {
    activateFallback?: boolean
    json?: boolean
}

export const registerChannelsSessions = (
    cmd: Command,
    program: Command
): void => {
    const sessions = cmd
        .command('sessions')
        .description('Manage channel sessions (per scope, switch active)')

    sessions
        .command('scopes <channelId>')
        .description('List scopes in a channel with their active session')
        .option('--json', 'emit raw JSON', false)
        .action(async (channelId: string, opts: ScopesOptions) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const scopes = await client.channels.listScopes(channelId)
            if (opts.json) {
                console.log(JSON.stringify(scopes, null, 2))
                return
            }
            if (scopes.length === 0) {
                console.log(kleur.dim('No scopes yet.'))
                return
            }
            for (const s of scopes) {
                const name = s.scopeName ? kleur.cyan(s.scopeName) : kleur.dim('(no name)')
                const active = s.activeSession
                    ? kleur.green(s.activeSession.channelSessionId)
                    : kleur.dim('(no active)')
                console.log(
                    `${kleur.dim(s.scopeKey)}  ${name}  count=${s.sessionCount}  active=${active}`
                )
            }
        })

    sessions
        .command('list <channelId>')
        .description('List channel sessions (optionally filtered by scope)')
        .option('--scope-key <key>', 'filter by scopeKey')
        .option('--include-archived', 'include archived sessions', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (channelId: string, opts: ListOptions) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const rows = await client.channels.listSessions(channelId, {
                scopeKey: opts.scopeKey,
                includeArchived: opts.includeArchived
            })
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2))
                return
            }
            if (rows.length === 0) {
                console.log(kleur.dim('No sessions.'))
                return
            }
            for (const r of rows) {
                const marker = r.isActive
                    ? kleur.green('▶')
                    : r.archivedAt
                      ? kleur.red('✗')
                      : kleur.dim('◻')
                const label = r.displayName
                    ? kleur.cyan(`🏷️ ${r.displayName}`)
                    : r.chatTitle
                      ? kleur.dim(r.chatTitle)
                      : kleur.dim('(untitled)')
                console.log(
                    `${marker}  ${r.channelSessionId}  ${kleur.dim(r.scopeKey)}  ${label}`
                )
            }
        })

    sessions
        .command('new <channelId>')
        .description(
            'Create a new active session in a scope (archives the current active)'
        )
        .requiredOption('--scope-key <key>', 'target scope key')
        .option('--name <name>', 'display name for the new session')
        .option('--json', 'emit raw JSON', false)
        .action(async (channelId: string, opts: NewOptions) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const created = await client.channels.createSession(channelId, {
                scopeKey: opts.scopeKey,
                displayName: opts.name ?? null
            })
            if (opts.json) {
                console.log(JSON.stringify(created, null, 2))
                return
            }
            console.log(
                kleur.green('✓'),
                'created session',
                kleur.cyan(created.channelSessionId)
            )
        })

    sessions
        .command('switch <channelId> <sessionId>')
        .description(
            'Make a session active (its scope swaps active to this session)'
        )
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                channelId: string,
                sessionId: string,
                opts: SwitchOptions
            ) => {
                const root = program.opts<RootChannelOptions>()
                const { client } = await buildClient(root)
                const updated = await client.channels.updateSession(
                    channelId,
                    sessionId,
                    { makeActive: true }
                )
                if (opts.json) {
                    console.log(JSON.stringify(updated, null, 2))
                    return
                }
                console.log(
                    kleur.green('✓'),
                    'switched to',
                    kleur.cyan(updated.channelSessionId)
                )
            }
        )

    sessions
        .command('rename <channelId> <sessionId> <name>')
        .description('Rename a session (sets display_name)')
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                channelId: string,
                sessionId: string,
                name: string,
                opts: RenameOptions
            ) => {
                const root = program.opts<RootChannelOptions>()
                const { client } = await buildClient(root)
                const updated = await client.channels.updateSession(
                    channelId,
                    sessionId,
                    { displayName: name }
                )
                if (opts.json) {
                    console.log(JSON.stringify(updated, null, 2))
                    return
                }
                console.log(
                    kleur.green('✓'),
                    'renamed',
                    kleur.cyan(updated.channelSessionId),
                    'to',
                    kleur.yellow(name)
                )
            }
        )

    sessions
        .command('delete <channelId> <sessionId>')
        .description(
            'Archive a session; with --activate-fallback, auto-activate newest remaining'
        )
        .option(
            '--activate-fallback',
            'if deleting the active session, auto-activate the newest remaining'
        )
        .option('--json', 'emit raw JSON', false)
        .action(
            async (
                channelId: string,
                sessionId: string,
                opts: DeleteOptions
            ) => {
                const root = program.opts<RootChannelOptions>()
                const { client } = await buildClient(root)
                const result = await client.channels.deleteSession(
                    channelId,
                    sessionId,
                    { activateFallback: opts.activateFallback }
                )
                if (opts.json) {
                    console.log(JSON.stringify(result, null, 2))
                    return
                }
                console.log(
                    kleur.green('✓'),
                    'archived',
                    kleur.cyan(result.archived.channelSessionId)
                )
                if (result.fallbackActivated) {
                    console.log(
                        kleur.dim('  fallback activated:'),
                        kleur.cyan(result.fallbackActivated.channelSessionId)
                    )
                }
            }
        )
}

