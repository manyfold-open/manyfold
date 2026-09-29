import { createInterface } from 'node:readline'
import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { renderCliError } from '@/output'
import { chatLink } from '@/commands/agent/create'
import {
    footer,
    humanView,
    pickSession,
    runTurn,
    TurnStreamLost
} from '@/commands/agent/chat-turn'
import { UsageError } from '@/usage-error'

interface ChatOptions {
    session?: string
    continue?: boolean
}

export type ReplLine =
    | { kind: 'exit' }
    | { kind: 'new' }
    | { kind: 'empty' }
    | { kind: 'message'; text: string }

// `/new` and `/exit` belong to this prompt; any other line, a slash command
// included, goes to the agent (Claude Code takes its own).
export const parseReplLine = (line: string): ReplLine => {
    const trimmed = line.trim()
    if (!trimmed) return { kind: 'empty' }
    if (trimmed === '/exit' || trimmed === '/quit') return { kind: 'exit' }
    if (trimmed === '/new') return { kind: 'new' }
    return { kind: 'message', text: line }
}

export const registerAgentChat = (cmd: Command, program: Command): void => {
    const chat = cmd
        .command('chat <agentId>')
        .description(
            'Talk to an agent in this terminal, one message per line (/new, /exit)'
        )
        .option('--session <id>', 'continue this session (default: a new one)')
        .option(
            '-c, --continue',
            "continue the agent's most recent session",
            false
        )
    chat.action(async (agentId: string, opts: ChatOptions) => {
        try {
            await runChat(program, agentId, opts)
        } catch (err) {
            if (err instanceof UsageError) chat.error(`error: ${err.message}`)
            throw err
        }
    })
}

type Prompted = { line: string } | { closed: true } | { interrupted: true }

// One line from a prompt that exists only while it waits: during a turn
// the terminal is back in normal mode, so Ctrl-C reaches the turn.
const prompt = (history: string[]): Promise<Prompted & { history: string[] }> =>
    new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
            history
        })
        let settled = false
        const settle = (outcome: Prompted): void => {
            if (settled) return
            settled = true
            const kept = [...(rl as unknown as { history: string[] }).history]
            rl.close()
            resolve({ ...outcome, history: kept })
        }
        rl.on('SIGINT', () => settle({ interrupted: true }))
        rl.on('close', () => settle({ closed: true }))
        rl.question(kleur.cyan('› '), (line) => settle({ line }))
    })

const runChat = async (
    program: Command,
    agentId: string,
    opts: ChatOptions
): Promise<void> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new UsageError(
            'mf agent chat needs a terminal; from a script or a pipe, use mf agent send'
        )
    if (opts.session && opts.continue)
        throw new UsageError(
            '--session and --continue both pick the session; pass one of them'
        )
    const { client } = await buildClient(
        program.opts<{ apiUrl?: string; token?: string }>()
    )
    const agent = await client.agents.get(agentId)
    // A new session is started with the first message, not before.
    let sessionId: string | null =
        opts.session || opts.continue
            ? (await pickSession(client, agentId, opts)).id
            : null
    console.error(
        kleur.dim(
            `${agent.name} (${agent.framework})${sessionId ? ` · session ${sessionId}` : ''} · /new starts a new session, /exit or Ctrl-D leaves`
        )
    )
    let history: string[] = []
    while (true) {
        const read = await prompt(history)
        history = read.history
        if ('interrupted' in read) {
            process.exitCode = 130
            return
        }
        if ('closed' in read) return
        const parsed = parseReplLine(read.line)
        if (parsed.kind === 'exit') return
        if (parsed.kind === 'empty') continue
        if (parsed.kind === 'new') {
            sessionId = null
            console.error(
                kleur.dim('a new session starts with your next message')
            )
            continue
        }
        try {
            if (!sessionId) {
                sessionId = (await pickSession(client, agentId, {})).id
                console.error(kleur.dim(`session ${sessionId}`))
            }
            const session = sessionId
            const view = humanView({
                stream: true,
                chatLink: () => chatLink(client, agentId, session)
            })
            const outcome = await runTurn(
                client,
                { agentId, sessionId: session, text: parsed.text },
                view
            )
            view.finish(outcome)
            if (outcome.cancelled)
                console.error(kleur.yellow('stopped the turn'))
            else if (outcome.error)
                console.error(kleur.red(`error: ${outcome.error.message}`))
            console.error(kleur.dim(footer(outcome, '')[0]))
        } catch (err) {
            if (err instanceof TurnStreamLost) {
                const link = await chatLink(client, agentId, err.sessionId)
                console.error(kleur.red(err.message))
                if (link)
                    console.error(
                        kleur.dim(`Follow it in the web chat: ${link}`)
                    )
            } else renderCliError({}, err)
        }
    }
}
