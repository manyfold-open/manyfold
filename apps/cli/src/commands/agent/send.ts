import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import kleur from 'kleur'
import { ApiError } from '@manyfold/sdk'
import { buildClient } from '@/client'
import { fail, jsonOption, printJson } from '@/output'
import { chatLink } from '@/commands/agent/create'
import {
    assertTakesFiles,
    checkFiles,
    footer,
    humanView,
    pickSession,
    quietView,
    readMessage,
    runTurn,
    TurnStreamLost,
    uploadFiles
} from '@/commands/agent/chat-turn'
import { UsageError } from '@/usage-error'

interface SendOptions {
    session?: string
    continue?: boolean
    file: string[]
    showThinking?: boolean
    json?: boolean
}

export const registerAgentSend = (cmd: Command, program: Command): void => {
    const send = jsonOption(
        cmd
            .command('send <agentId> [message...]')
            .description(
                'Send a message to an agent and print its reply ("-" or a pipe: the message from stdin)'
            )
            .option(
                '--session <id>',
                'continue this session (default: a new one)'
            )
            .option(
                '-c, --continue',
                "continue the agent's most recent session",
                false
            )
            .option(
                '--file <path>',
                "attach a local file or image (PNG, JPG, …), uploaded to the agent's workspace (repeatable)",
                (value: string, previous: string[]) => [...previous, value],
                [] as string[]
            )
            .option(
                '--show-thinking',
                "print the agent's thinking, dim on stderr, as it streams (with --json: a thinking field)",
                false
            )
    )
    send.action(async (agentId: string, words: string[], opts: SendOptions) => {
        try {
            await runSend(program, agentId, words, opts)
        } catch (err) {
            if (err instanceof UsageError) send.error(`error: ${err.message}`)
            throw err
        }
    })
}

const runSend = async (
    program: Command,
    agentId: string,
    words: string[],
    opts: SendOptions
): Promise<void> => {
    const global = program.opts<{ apiUrl?: string; token?: string }>()
    if (opts.session && opts.continue)
        throw new UsageError(
            '--session and --continue both pick the session; pass one of them'
        )
    const fromStdin =
        (words.length === 1 && words[0] === '-') ||
        (words.length === 0 && !process.stdin.isTTY)
    if (fromStdin && global.token === '-')
        throw new UsageError(
            '--token - already reads stdin; pass the message as arguments'
        )
    const text = readMessage(words, {
        isTTY: process.stdin.isTTY === true,
        read: () => readFileSync(0, 'utf8')
    })
    const files = await checkFiles(opts.file)
    if (!text.trim() && files.length === 0)
        throw new UsageError('nothing to send: pass a message, or --file')
    const { client } = await buildClient(global)
    if (files.length > 0) assertTakesFiles(await client.agents.get(agentId))
    const session = await pickSession(client, agentId, opts)
    const link = () => chatLink(client, agentId, session.id)
    const human = humanView({
        stream: !opts.json && process.stdout.isTTY === true,
        showThinking: opts.showThinking,
        chatLink: link
    })
    let outcome
    try {
        const attachments = await uploadFiles(
            client,
            agentId,
            session.id,
            files
        )
        outcome = await runTurn(
            client,
            {
                agentId,
                sessionId: session.id,
                ...(text.trim() ? { text } : {}),
                attachments
            },
            opts.json ? quietView : human
        )
    } catch (err) {
        if (err instanceof TurnStreamLost) {
            const url = await link()
            fail(opts, err, {
                hint: url
                    ? `Follow it in the web chat: ${url}`
                    : `Follow it with mf agent send ${agentId} --session ${session.id}, or in the web chat.`
            })
            return
        }
        // Nothing reached the session: leave no empty one behind. A session
        // with a turn under way refuses the delete, which is what we want.
        if (session.created)
            await client.chat
                .deleteSession(agentId, session.id)
                .catch(() => undefined)
        // A 409 without a code of its own is the session's turn still
        // running; coded ones (a terminal holding the session, a sandbox's
        // CLI too old for the upload) carry their own hints.
        if (
            err instanceof ApiError &&
            err.status === 409 &&
            err.code === 'bad_request'
        ) {
            fail(opts, err, {
                hint: 'A turn is still running in this session: wait for it (it shows in the web chat), or leave out --session / --continue to start a new session.'
            })
            return
        }
        throw err
    }
    process.exitCode = outcome.cancelled ? 130 : outcome.error ? 1 : 0
    if (opts.json) {
        printJson({
            sessionId: outcome.sessionId,
            userMessageId: outcome.userMessageId,
            assistantMessageId: outcome.assistantMessageId,
            text: outcome.text,
            ...(opts.showThinking ? { thinking: outcome.thinking } : {}),
            usage: outcome.usage,
            error: outcome.error
        })
        return
    }
    human.finish(outcome)
    if (outcome.cancelled) console.error(kleur.yellow('stopped the turn'))
    else if (outcome.error)
        console.error(
            kleur.red(`error: ${outcome.error.message}`),
            kleur.dim(`(${outcome.error.code})`)
        )
    for (const line of footer(
        outcome,
        `mf agent send ${agentId} --session ${outcome.sessionId} "…"`
    ))
        console.error(kleur.dim(line))
}
