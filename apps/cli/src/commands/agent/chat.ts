import { createInterface } from 'node:readline'
import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { renderCliError } from '@/output'
import { chatLink } from '@/commands/agent/create'
import type { NcaClient } from '@manyfold/sdk'
import {
    assertTakesFiles,
    checkFiles,
    footer,
    humanView,
    pickSession,
    runTurn,
    TurnStreamLost,
    uploadFiles,
    type LocalFile,
    type TurnOutcome,
    type TurnView
} from '@/commands/agent/chat-turn'
import { UsageError } from '@/usage-error'

interface ChatOptions {
    session?: string
    continue?: boolean
    file: string[]
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
        .option(
            '--file <path>',
            "attach a local file or image (PNG, JPG, …) to your first message, uploaded to the agent's workspace (repeatable)",
            (value: string, previous: string[]) => [...previous, value],
            [] as string[]
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

export interface ReplState {
    // Null until the first message starts a session.
    sessionId: string | null
    // What --file named, until a message has taken it.
    files: LocalFile[]
}

// One message from the prompt. The files still waiting go with it; they
// stay waiting when their upload or the message itself was refused, and go
// once the message is out, even if its reply is then lost.
export const replTurn = async (
    client: NcaClient,
    agentId: string,
    state: ReplState,
    text: string,
    view: TurnView
): Promise<TurnOutcome> => {
    if (!state.sessionId) {
        state.sessionId = (await pickSession(client, agentId, {})).id
        console.error(kleur.dim(`session ${state.sessionId}`))
    }
    const attachments = await uploadFiles(
        client,
        agentId,
        state.sessionId,
        state.files
    )
    try {
        const outcome = await runTurn(
            client,
            { agentId, sessionId: state.sessionId, text, attachments },
            view
        )
        state.files = []
        return outcome
    } catch (err) {
        if (err instanceof TurnStreamLost) state.files = []
        throw err
    }
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
    if (opts.session && opts.continue)
        throw new UsageError(
            '--session and --continue both pick the session; pass one of them'
        )
    const files = await checkFiles(opts.file)
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new UsageError(
            'mf agent chat needs a terminal; from a script or a pipe, use mf agent send'
        )
    const { client } = await buildClient(
        program.opts<{ apiUrl?: string; token?: string }>()
    )
    const agent = await client.agents.get(agentId)
    if (files.length > 0) assertTakesFiles(agent)
    // A new session is started with the first message, not before.
    const state: ReplState = {
        sessionId:
            opts.session || opts.continue
                ? (await pickSession(client, agentId, opts)).id
                : null,
        files
    }
    console.error(
        kleur.dim(
            `${agent.name} (${agent.framework})${state.sessionId ? ` · session ${state.sessionId}` : ''} · /new starts a new session, /exit or Ctrl-D leaves`
        )
    )
    if (files.length > 0)
        console.error(
            kleur.dim(
                `${files.map((file) => file.name).join(', ')} ${files.length > 1 ? 'go' : 'goes'} with your first message`
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
            state.sessionId = null
            console.error(
                kleur.dim('a new session starts with your next message')
            )
            continue
        }
        try {
            const view = humanView({
                stream: true,
                chatLink: () =>
                    chatLink(client, agentId, state.sessionId ?? undefined)
            })
            const outcome = await replTurn(
                client,
                agentId,
                state,
                parsed.text,
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
