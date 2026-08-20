import { createObjectId } from '@manyfold/shared'
import { Injectable, Logger } from '@nestjs/common'
import type { ChannelRow, ChannelSessionRow } from '@manyfold/db'
import { ChatService } from '@/modules/chat/chat.service'
import { ChannelsRepository } from './channels.repository'

export interface ResolvedSession {
    session: ChannelSessionRow
    chatSessionId: string
    isNew: boolean
}

export interface ForkOptions {
    displayName?: string | null
    scopeName?: string | null
    remoteUserId?: string | null
    remoteThreadId?: string | null
}

@Injectable()
export class ChannelSessionRouter {
    private readonly logger = new Logger(ChannelSessionRouter.name)
    private readonly inflight = new Map<string, Promise<ResolvedSession>>()

    constructor(
        private readonly repo: ChannelsRepository,
        private readonly chat: ChatService
    ) {}

    async resolveActive(
        channel: ChannelRow,
        scopeKey: string,
        scopeName: string | null,
        remote: { senderId: string; threadId: string | null }
    ): Promise<ResolvedSession> {
        const dedupeKey = `${channel.id}:${scopeKey}`
        const existing = this.inflight.get(dedupeKey)
        if (existing) return existing
        const promise = this.doResolveActive(
            channel,
            scopeKey,
            scopeName,
            remote
        )
        this.inflight.set(dedupeKey, promise)
        try {
            return await promise
        } finally {
            this.inflight.delete(dedupeKey)
        }
    }

    async fork(
        channel: ChannelRow,
        scopeKey: string,
        opts: ForkOptions = {}
    ): Promise<ResolvedSession> {
        const title = this.buildChatTitle(channel, opts.scopeName ?? null)
        const chatSession = await this.chat.createSession(
            channel.userId,
            channel.agentId,
            title
        )
        const now = new Date()
        try {
            const { inserted } = await this.repo.forkActiveSession(
                channel.id,
                scopeKey,
                {
                    id: createObjectId('channelSession'),
                    channelId: channel.id,
                    chatSessionId: chatSession.id,
                    scopeKey,
                    scopeName: opts.scopeName ?? null,
                    displayName: opts.displayName ?? null,
                    remoteUserId: opts.remoteUserId ?? null,
                    remoteThreadId: opts.remoteThreadId ?? null,
                    isActive: true,
                    archivedAt: null,
                    lastInboundAt: now,
                    lastOutboundAt: null,
                    createdAt: now,
                    updatedAt: now
                }
            )
            return {
                session: inserted,
                chatSessionId: inserted.chatSessionId,
                isNew: true
            }
        } catch (err) {
            await this.chat
                .deleteSession(
                    channel.userId,
                    channel.agentId,
                    chatSession.id,
                    true
                )
                .catch((cleanupErr) => {
                    this.logger.warn(
                        `failed to cleanup orphan chat session=${chatSession.id}: ${(cleanupErr as Error).message}`
                    )
                })
            throw err
        }
    }

    async switchTo(
        channel: ChannelRow,
        scopeKey: string,
        targetId: string
    ): Promise<ResolvedSession> {
        const { activated } = await this.repo.swapActiveSession(
            channel.id,
            scopeKey,
            targetId
        )
        return {
            session: activated,
            chatSessionId: activated.chatSessionId,
            isNew: false
        }
    }

    private async doResolveActive(
        channel: ChannelRow,
        scopeKey: string,
        scopeName: string | null,
        remote: { senderId: string; threadId: string | null }
    ): Promise<ResolvedSession> {
        const existing = await this.repo.findActiveSession(channel.id, scopeKey)
        if (existing)
            return {
                session: existing,
                chatSessionId: existing.chatSessionId,
                isNew: false
            }

        const title = this.buildChatTitle(channel, scopeName)
        const chatSession = await this.chat.createSession(
            channel.userId,
            channel.agentId,
            title
        )
        const now = new Date()
        try {
            const inserted = await this.repo.insertSession({
                id: createObjectId('channelSession'),
                channelId: channel.id,
                chatSessionId: chatSession.id,
                scopeKey,
                scopeName,
                displayName: null,
                remoteUserId: remote.senderId,
                remoteThreadId: remote.threadId,
                isActive: true,
                archivedAt: null,
                lastInboundAt: now,
                lastOutboundAt: null,
                createdAt: now,
                updatedAt: now
            })
            return {
                session: inserted,
                chatSessionId: inserted.chatSessionId,
                isNew: true
            }
        } catch (err) {
            const racing = await this.repo.findActiveSession(
                channel.id,
                scopeKey
            )
            if (racing) {
                this.logger.warn(
                    `lost insert race for channel=${channel.id} scopeKey=${scopeKey}, reusing existing session`
                )
                await this.chat
                    .deleteSession(
                        channel.userId,
                        channel.agentId,
                        chatSession.id,
                        true
                    )
                    .catch((cleanupErr) => {
                        this.logger.warn(
                            `failed to cleanup orphan chat session=${chatSession.id}: ${(cleanupErr as Error).message}`
                        )
                    })
                return {
                    session: racing,
                    chatSessionId: racing.chatSessionId,
                    isNew: false
                }
            }
            throw err
        }
    }

    private buildChatTitle(
        channel: ChannelRow,
        scopeName: string | null
    ): string {
        return scopeName && scopeName.trim()
            ? `${channel.label} · ${scopeName.trim()}`
            : channel.label
    }
}
