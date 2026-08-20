import type { Command } from 'commander'
import { ApiError, buildApiError } from '@manyfold/sdk'
import { apiPaths, type AgentChannelSendResult } from '@manyfold/shared'
import { buildClient } from '@/client'
import { createCliFetch } from '@/transport'
import type { RootChannelOptions } from './helpers'

export interface ChannelSendFlags {
    chatId?: string
    userId?: string
    replyTo?: string
    text?: string
    file?: string[]
}

export interface ChannelSendBody {
    text?: string
    files?: string[]
    chatId?: string
    userId?: string
    replyToMessageId?: string
}

export const buildSendBody = (flags: ChannelSendFlags): ChannelSendBody => {
    const text = flags.text?.trim()
    const files = (flags.file ?? []).map((p) => p.trim()).filter(Boolean)
    if (!text && files.length === 0)
        throw new Error('provide --text, --file, or both')
    if (files.length > 4) throw new Error('at most 4 --file attachments')
    const targets: Array<Partial<ChannelSendBody>> = []
    if (flags.chatId) targets.push({ chatId: flags.chatId })
    if (flags.userId) targets.push({ userId: flags.userId })
    if (flags.replyTo) targets.push({ replyToMessageId: flags.replyTo })
    const target = targets[0]
    if (!target || targets.length !== 1)
        throw new Error(
            'exactly one target is required: --chat-id, --user-id or --reply-to'
        )
    return {
        ...(text ? { text } : {}),
        ...(files.length > 0 ? { files } : {}),
        ...target
    }
}

class ChannelSendAuthError extends ApiError {
    constructor(cause?: ApiError) {
        super({
            status: cause?.status ?? 401,
            statusText: cause?.statusText ?? 'Unauthorized',
            code: cause?.code ?? 'unauthorized',
            message:
                'cannot send via this channel with this token.\n' +
                '- Agent runtime: the channel must be bound to THIS agent (run `mf channels list`).\n' +
                '- User (mf login): the token needs the channels:edit scope and must own the channel.',
            body: cause?.body ?? '',
            details: cause?.details
        })
        this.name = 'ChannelSendAuthError'
    }
}

export const registerChannelsSend = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('send <channelId>')
        .description(
            'Send a message through a channel as its bound agent (chat, DM, or native reply)'
        )
        .option('--chat-id <chatId>', 'target a chat/group by provider chat id')
        .option(
            '--user-id <userId>',
            'DM a provider user id (e.g. Lark open_id)'
        )
        .option(
            '--reply-to <messageId>',
            'reply natively to a provider message id'
        )
        .option('--text <text>', 'message text')
        .option(
            '--file <path>',
            'attach a workspace file (repeatable, max 4)',
            (value: string, previous: string[]) => [...previous, value],
            [] as string[]
        )
        .option('--json', 'emit raw JSON (default)', true)
        .action(
            async (
                channelId: string,
                opts: ChannelSendFlags & { json?: boolean }
            ) => {
                const root = program.opts<RootChannelOptions>()
                const body = buildSendBody(opts)
                const { ctx } = await buildClient(root)
                if (!ctx.token) throw new ChannelSendAuthError()
                const res = await createCliFetch()(
                    `${ctx.apiUrl}${apiPaths.AGENT_SELF_CHANNEL_SEND(channelId)}`,
                    {
                        method: 'POST',
                        headers: {
                            authorization: `Bearer ${ctx.token}`,
                            'content-type': 'application/json',
                            accept: 'application/json'
                        },
                        body: JSON.stringify(body)
                    }
                )
                if (!res.ok) {
                    const error = await buildApiError(res)
                    if (res.status === 401 || res.status === 403)
                        throw new ChannelSendAuthError(error)
                    throw error
                }
                const result = (await res.json()) as AgentChannelSendResult
                console.log(JSON.stringify(result, null, 2))
            }
        )
}
