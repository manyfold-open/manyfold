import type { ChatContentBlock } from '@manyfold/shared'
import { Injectable } from '@nestjs/common'
import type { ChannelRow, ChannelSessionRow } from '@manyfold/db'
import { ChatService } from '@/modules/chat/chat.service'
import { AgentModelConfigService } from '@/modules/agents/model-config/agent-model-config.service'
import { UsageRepository } from '@/modules/usage/usage.repository'
import { ChannelsRepository } from '../channels.repository'
import type { ChannelSessionWithChatTitle } from '../channels.repository'
import type {
    ChannelCommandView,
    NormalizedInboundAction,
    SessionCardItem
} from '../channel-provider'
import { ChannelSessionRouter } from '../channel-session-router.service'
import {
    isKnownSlashCommand,
    parseSlashCommand,
    type ParsedSlashCommand
} from './parser'
import { buildHelpText, slashCommandScope } from './commands'
import { matchSession } from './match-session'

export interface SlashDispatchContext {
    channel: ChannelRow
    scopeKey: string
    scopeName: string | null
    senderId: string
    senderName: string | null
    // Whether the actor may run agent-scoped commands. Providers with no actor
    // model pass true (unchanged behavior); Slack passes the operator verdict.
    operator: boolean
}

export interface SlashDispatchResult {
    replyText: string
    view?: ChannelCommandView
    // Set when an agent-scoped command was refused because the actor is not an
    // operator. The reply is still sent; the delivery is recorded as dropped.
    denied?: boolean
    sideEffect:
        | 'noop'
        | 'session_forked'
        | 'session_switched'
        | 'session_renamed'
        | 'session_archived'
        | 'turn_stopped'
    command: string
}

const ARCHIVE_LOOKBACK_DAYS = 30

@Injectable()
export class ChannelSlashDispatcher {
    constructor(
        private readonly repo: ChannelsRepository,
        private readonly router: ChannelSessionRouter,
        private readonly chat: ChatService,
        private readonly modelConfig: AgentModelConfigService,
        private readonly usage: UsageRepository
    ) {}

    tryParse(text: string): ParsedSlashCommand | null {
        const parsed = parseSlashCommand(text)
        if (!parsed) return null
        if (!isKnownSlashCommand(parsed.command)) return null
        return parsed
    }

    async dispatchAction(
        action: NormalizedInboundAction,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const verb = action.action
        if (verb === 'act:/new-session') {
            return this.handleNew(
                { command: 'new', args: [], rest: '' },
                ctx
            )
        }
        if (verb === 'act:/switch-session' && action.targetChannelSessionId) {
            return this.handleSwitch(
                {
                    command: 'switch',
                    args: [action.targetChannelSessionId],
                    rest: action.targetChannelSessionId
                },
                ctx
            )
        }
        if (verb === 'act:/delete-session' && action.targetChannelSessionId) {
            return this.handleDelete(
                {
                    command: 'delete',
                    args: [action.targetChannelSessionId],
                    rest: action.targetChannelSessionId
                },
                ctx
            )
        }
        if (verb === 'nav:/list-page') {
            const page = action.targetPage ?? 1
            return this.handleList(
                {
                    command: 'list',
                    args: [String(page)],
                    rest: String(page)
                },
                ctx
            )
        }
        if (verb === 'nav:/current') {
            return this.handleCurrent(ctx)
        }
        return {
            replyText: `Unknown action «${verb}».`,
            sideEffect: 'noop',
            command: verb
        }
    }

    async dispatch(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        if (slashCommandScope(parsed.command) === 'agent' && !ctx.operator)
            return {
                replyText: `/${parsed.command} changes agent-wide settings and is limited to channel operators. Ask the channel owner to add your user ID under "Operator user IDs" for this channel in the Manyfold web app.`,
                denied: true,
                sideEffect: 'noop',
                command: parsed.command
            }
        switch (parsed.command) {
            case 'new':
                return this.handleNew(parsed, ctx)
            case 'list':
                return this.handleList(parsed, ctx)
            case 'switch':
                return this.handleSwitch(parsed, ctx)
            case 'current':
                return this.handleCurrent(ctx)
            case 'rename':
                return this.handleRename(parsed, ctx)
            case 'delete':
                return this.handleDelete(parsed, ctx)
            case 'stop':
                return this.handleStop(ctx)
            case 'model':
                return this.handleModel(parsed, ctx)
            case 'usage':
                return this.handleUsage(ctx)
            case 'history':
                return this.handleHistory(ctx)
            case 'help':
                return this.handleHelp(parsed.command)
            default:
                return {
                    replyText: `Unknown command /${parsed.command}. Try /help.`,
                    sideEffect: 'noop',
                    command: parsed.command
                }
        }
    }

    private async handleNew(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const displayName = parsed.rest.trim() || null
        await this.router.fork(ctx.channel, ctx.scopeKey, {
            displayName,
            scopeName: ctx.scopeName,
            remoteUserId: ctx.senderId,
            remoteThreadId: null
        })
        const sessions = await this.listScope(ctx.channel.id, ctx.scopeKey)
        const newIndex = sessions.length
        const label = displayName ? `🏷️ «${displayName}»` : '(untitled)'
        return {
            replyText: `✓ New session #${newIndex} ${label} created.`,
            sideEffect: 'session_forked',
            command: 'new'
        }
    }

    private async handleList(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const sessions = await this.listScope(ctx.channel.id, ctx.scopeKey)
        if (sessions.length === 0) {
            return {
                replyText:
                    'No sessions yet in this chat. Send a message to start one, or use /new.',
                view: {
                    kind: 'session_list',
                    text:
                        'No sessions yet in this chat. Send a message to start one, or use /new.',
                    items: [],
                    page: { current: 1, total: 1 }
                },
                sideEffect: 'noop',
                command: 'list'
            }
        }

        const pageSize = 20
        const totalPages = Math.max(1, Math.ceil(sessions.length / pageSize))
        const requested =
            parsed.args.length > 0 ? Number.parseInt(parsed.args[0], 10) : 1
        const page = clamp(Number.isFinite(requested) ? requested : 1, 1, totalPages)
        const start = (page - 1) * pageSize
        const end = Math.min(start + pageSize, sessions.length)

        const lines: string[] = []
        if (totalPages > 1)
            lines.push(
                `Sessions in this chat (${sessions.length} total, page ${page}/${totalPages}):`
            )
        else
            lines.push(`Sessions in this chat (${sessions.length} total):`)
        const items: SessionCardItem[] = []
        for (let i = start; i < end; i += 1) {
            const item = sessions[i]
            lines.push(renderSessionLine(i + 1, item))
            items.push(toCardItem(i + 1, item))
        }
        lines.push('Use /switch <number|name>, /current, /new, /help.')
        const text = lines.join('\n')
        return {
            replyText: text,
            view: {
                kind: 'session_list',
                text,
                items,
                page: { current: page, total: totalPages }
            },
            sideEffect: 'noop',
            command: 'list'
        }
    }

    private async handleSwitch(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        if (parsed.rest === '') {
            return {
                replyText:
                    'Usage: /switch <number|name>. Use /list to see sessions.',
                sideEffect: 'noop',
                command: 'switch'
            }
        }
        const sessions = await this.listScopeIncludingArchived(
            ctx.channel.id,
            ctx.scopeKey
        )
        const matched = matchSession(sessions, parsed.rest)
        if (!matched) {
            return {
                replyText: `No session matched «${parsed.rest}». Use /list to see sessions.`,
                sideEffect: 'noop',
                command: 'switch'
            }
        }
        if (matched.session.archivedAt !== null) {
            return {
                replyText:
                    'That session has been deleted and cannot be switched to. Use /new to start a fresh one.',
                sideEffect: 'noop',
                command: 'switch'
            }
        }
        if (matched.session.isActive) {
            const idx = await this.indexOfSession(
                ctx.channel.id,
                ctx.scopeKey,
                matched.session.id
            )
            return {
                replyText: `Already on #${idx} ${labelFor(matched)}.`,
                sideEffect: 'noop',
                command: 'switch'
            }
        }
        await this.router.switchTo(
            ctx.channel,
            ctx.scopeKey,
            matched.session.id
        )
        const idx = await this.indexOfSession(
            ctx.channel.id,
            ctx.scopeKey,
            matched.session.id
        )
        return {
            replyText: `✓ Switched to #${idx} ${labelFor(matched)}.`,
            sideEffect: 'session_switched',
            command: 'switch'
        }
    }

    private async handleCurrent(
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const active = await this.repo.findActiveSession(
            ctx.channel.id,
            ctx.scopeKey
        )
        if (!active) {
            const text =
                'No active session in this chat yet. Send a message to start one, or use /new.'
            return {
                replyText: text,
                view: { kind: 'session_detail', text, item: null },
                sideEffect: 'noop',
                command: 'current'
            }
        }
        const sessions = await this.listScope(ctx.channel.id, ctx.scopeKey)
        const idx =
            sessions.findIndex((s) => s.session.id === active.id) + 1
        const item = sessions[idx - 1]
        const text = `Current: #${idx} ${labelFor(item)}. Created ${formatRelative(active.createdAt)}.`
        return {
            replyText: text,
            view: {
                kind: 'session_detail',
                text,
                item: item ? toCardItem(idx, item) : null
            },
            sideEffect: 'noop',
            command: 'current'
        }
    }

    private async handleRename(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const name = parsed.rest.trim()
        const active = await this.repo.findActiveSession(
            ctx.channel.id,
            ctx.scopeKey
        )
        if (!active) {
            return {
                replyText:
                    'No active session to rename. Use /new <name> to create one.',
                sideEffect: 'noop',
                command: 'rename'
            }
        }
        if (name === '') {
            if (active.displayName === null) {
                return {
                    replyText: 'No custom name to clear.',
                    sideEffect: 'noop',
                    command: 'rename'
                }
            }
            const previousName = active.displayName
            await this.repo.renameSession(active.id, null)
            return {
                replyText: `✓ Cleared the custom name (was «${previousName}»). Showing the default title now.`,
                sideEffect: 'session_renamed',
                command: 'rename'
            }
        }
        await this.repo.renameSession(active.id, name)
        return {
            replyText: `✓ Renamed to «${name}».`,
            sideEffect: 'session_renamed',
            command: 'rename'
        }
    }

    private async handleDelete(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        if (parsed.rest === '') {
            return {
                replyText:
                    'Usage: /delete <number|name>. Use /list to see sessions.',
                sideEffect: 'noop',
                command: 'delete'
            }
        }
        const sessions = await this.listScope(ctx.channel.id, ctx.scopeKey)
        const matched = matchSession(sessions, parsed.rest)
        if (!matched) {
            return {
                replyText: `No session matched «${parsed.rest}». Use /list to see sessions.`,
                sideEffect: 'noop',
                command: 'delete'
            }
        }
        const wasActive = matched.session.isActive
        const result = await this.repo.archiveSession(matched.session.id, {
            activateFallback: wasActive
        })
        if (wasActive && result.fallbackActivated) {
            const after = await this.listScope(ctx.channel.id, ctx.scopeKey)
            const idx =
                after.findIndex(
                    (s) => s.session.id === result.fallbackActivated?.id
                ) + 1
            const item = after[idx - 1]
            return {
                replyText: `✓ Deleted. Fallback active: #${idx} ${item ? labelFor(item) : '(untitled)'}.`,
                sideEffect: 'session_archived',
                command: 'delete'
            }
        }
        if (wasActive) {
            return {
                replyText:
                    '✓ Deleted. No remaining sessions — next message will start a fresh one.',
                sideEffect: 'session_archived',
                command: 'delete'
            }
        }
        return {
            replyText: `✓ Deleted ${labelFor(matched)}.`,
            sideEffect: 'session_archived',
            command: 'delete'
        }
    }

    private async handleStop(
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        // Drop the queue before cancelling so the post-finalize drain kick
        // cannot start a queued message in the gap between cancel and drop.
        const discarded = await this.repo.dropQueuedInboundForScope(
            ctx.channel.id,
            ctx.scopeKey
        )
        const active = await this.repo.findActiveSession(
            ctx.channel.id,
            ctx.scopeKey
        )
        const inflight = active
            ? await this.chat.hasInflightTurn(active.chatSessionId)
            : false
        const discardNote =
            discarded > 0 ? ` Discarded ${discarded} queued message(s).` : ''
        if (inflight && active) {
            await this.chat.cancelStream(
                ctx.channel.userId,
                ctx.channel.agentId,
                active.chatSessionId
            )
            return {
                replyText: `⏹ Stopping the current response…${discardNote}`,
                sideEffect: 'turn_stopped',
                command: 'stop'
            }
        }
        if (discarded > 0)
            return {
                replyText: `No response in progress.${discardNote}`,
                sideEffect: 'turn_stopped',
                command: 'stop'
            }
        return {
            replyText: 'No response in progress.',
            sideEffect: 'noop',
            command: 'stop'
        }
    }

    private async handleModel(
        parsed: ParsedSlashCommand,
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const value = parsed.rest.trim()
        const { userId, agentId } = ctx.channel
        if (value === '') {
            try {
                const view = await this.modelConfig.getForAgent(
                    userId,
                    agentId,
                    false
                )
                const options = view.options
                    .filter((o) => o.enabled)
                    .map((o) => o.value)
                if (options.length === 0)
                    return {
                        replyText: `Model configuration isn't available for this agent (framework ${view.framework}).`,
                        sideEffect: 'noop',
                        command: 'model'
                    }
                const shown = options.slice(0, 20).join(', ')
                const more =
                    options.length > 20
                        ? ` … (+${options.length - 20} more)`
                        : ''
                return {
                    replyText: [
                        `Current model: ${view.config?.model ?? '(default)'}`,
                        `Available: ${shown}${more}`,
                        'Use /model <name> to change it (applies to all sessions).'
                    ].join('\n'),
                    sideEffect: 'noop',
                    command: 'model'
                }
            } catch (err) {
                return {
                    replyText: `Could not read model config: ${errorMessage(err)}`,
                    sideEffect: 'noop',
                    command: 'model'
                }
            }
        }
        try {
            const view = await this.modelConfig.updateForAgent(
                userId,
                agentId,
                { model: value },
                false
            )
            return {
                replyText: `✓ Model set to «${view.config?.model ?? value}» — this is the agent default and applies to all sessions.`,
                sideEffect: 'noop',
                command: 'model'
            }
        } catch (err) {
            return {
                replyText: `Could not set model: ${errorMessage(err)}`,
                sideEffect: 'noop',
                command: 'model'
            }
        }
    }

    private async handleUsage(
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const { userId, agentId } = ctx.channel
        const active = await this.repo.findActiveSession(
            ctx.channel.id,
            ctx.scopeKey
        )
        const lines: string[] = []
        if (active) {
            const s = await this.usage.summary({
                userId,
                agentId,
                sessionId: active.chatSessionId
            })
            lines.push(
                `This session: ${formatTokens(s.totalInputTokens + s.totalOutputTokens)} tokens · ${formatCost(s.totalCostUsd)} · ${s.eventCount} turn(s)`
            )
        } else {
            lines.push('This session: no active session yet.')
        }
        const since = new Date(
            Date.now() - 30 * 24 * 60 * 60 * 1000
        ).toISOString()
        const agg = await this.usage.summary({ userId, agentId, from: since })
        lines.push(
            `Agent (30d): ${formatTokens(agg.totalInputTokens + agg.totalOutputTokens)} tokens · ${formatCost(agg.totalCostUsd)} · ${agg.eventCount} turn(s)`
        )
        return { replyText: lines.join('\n'), sideEffect: 'noop', command: 'usage' }
    }

    private async handleHistory(
        ctx: SlashDispatchContext
    ): Promise<SlashDispatchResult> {
        const active = await this.repo.findActiveSession(
            ctx.channel.id,
            ctx.scopeKey
        )
        if (!active)
            return {
                replyText: 'No active session yet.',
                sideEffect: 'noop',
                command: 'history'
            }
        const page = await this.chat.listMessagePage(
            ctx.channel.userId,
            ctx.channel.agentId,
            active.chatSessionId,
            { limit: 8 }
        )
        if (page.messages.length === 0)
            return {
                replyText: 'No messages in the active session yet.',
                sideEffect: 'noop',
                command: 'history'
            }
        const lines = page.messages.map((message) => {
            const who =
                message.role === 'user'
                    ? 'You'
                    : message.role === 'assistant'
                      ? 'Bot'
                      : message.role
            const text = message.contentBlocks
                .filter(
                    (b): b is Extract<ChatContentBlock, { type: 'text' }> =>
                        b.type === 'text'
                )
                .map((b) => b.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            const snippet =
                text.length > 80
                    ? `${text.slice(0, 79)}…`
                    : text || '(no text)'
            return `${who}: ${snippet}`
        })
        return {
            replyText: lines.join('\n'),
            sideEffect: 'noop',
            command: 'history'
        }
    }

    private handleHelp(command: string): SlashDispatchResult {
        return { replyText: buildHelpText(), sideEffect: 'noop', command }
    }

    private async listScope(
        channelId: string,
        scopeKey: string
    ): Promise<ChannelSessionWithChatTitle[]> {
        return this.repo.listScopeSessionsWithChatTitle(channelId, scopeKey, {
            includeArchived: false
        })
    }

    private async listScopeIncludingArchived(
        channelId: string,
        scopeKey: string
    ): Promise<ChannelSessionWithChatTitle[]> {
        const since = new Date(
            Date.now() - ARCHIVE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
        )
        return this.repo.listScopeSessionsWithChatTitle(channelId, scopeKey, {
            archivedSince: since
        })
    }

    private async indexOfSession(
        channelId: string,
        scopeKey: string,
        sessionId: string
    ): Promise<number> {
        const sessions = await this.listScope(channelId, scopeKey)
        const idx = sessions.findIndex((s) => s.session.id === sessionId)
        return idx === -1 ? 0 : idx + 1
    }
}

const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value))

const renderSessionLine = (
    index: number,
    item: ChannelSessionWithChatTitle
): string => {
    const session = item.session
    const marker = session.isActive ? '▶' : session.archivedAt ? '✗' : '◻'
    return `${marker} ${index}. ${labelFor(item)} · created ${formatRelative(session.createdAt)}`
}

const toCardItem = (
    index: number,
    item: ChannelSessionWithChatTitle
): SessionCardItem => {
    const session = item.session
    return {
        index,
        channelSessionId: session.id,
        chatSessionId: session.chatSessionId,
        displayName: session.displayName,
        chatTitle: item.chatTitle,
        isActive: session.isActive,
        archivedAt: session.archivedAt,
        lastActivityAt:
            session.lastInboundAt ??
            session.lastOutboundAt ??
            session.updatedAt
    }
}

const labelFor = (item: ChannelSessionWithChatTitle): string => {
    const name = item.session.displayName
    if (name) return `🏷️ «${name}»`
    if (item.chatTitle) return truncate(item.chatTitle, 40)
    return '(untitled)'
}

const truncate = (value: string, max: number): string => {
    if (value.length <= max) return value
    return `${value.slice(0, max - 1)}…`
}

const formatRelative = (when: Date): string => {
    const diff = Date.now() - when.getTime()
    if (diff < 0) return 'just now'
    const secs = Math.floor(diff / 1000)
    if (secs < 60) return `${secs}s ago`
    const mins = Math.floor(secs / 60)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return when.toISOString().slice(0, 10)
}

const formatTokens = (n: number): string =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

const formatCost = (usd: number | null): string =>
    usd === null ? 'cost n/a' : `$${usd.toFixed(usd < 1 ? 3 : 2)}`

const errorMessage = (err: unknown): string => {
    const message = (err as { message?: unknown }).message
    return typeof message === 'string' ? message : 'unknown error'
}

export type { ChannelSessionRow }
