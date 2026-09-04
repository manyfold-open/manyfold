import { createObjectId } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentRuntime,
    ChatContentBlock,
    ChatMessage,
    ChatSessionSummary,
    AgentSessionListItem,
    AgentSessionListResponse,
    AgentSessionLocalScan,
    RuntimeSessionCandidate,
    RuntimeSessionRebuildParsedResponse,
    RuntimeSessionRecoverRawResponse,
    RuntimeSessionRestoreResponse,
    RuntimeSessionSyncResponse,
    RuntimeSessionViewResponse
} from '@manyfold/shared'
import {
    BadRequestException,
    ConflictException,
    HttpException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
    agents,
    type Agent,
    type ChatMessage as DbChatMessage,
    type ChatMessageSource as DbChatMessageSource,
    type ChatSession as DbChatSession,
    type Database,
    type NewChatMessage,
    type NewChatMessageSource
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { sanitizeForJsonb } from '@/common/jsonb-sanitize'
import { ChatRepository } from '@/modules/chat/chat.repository'
import {
    ExecDriverFactory,
    type RecoveryFsHandle
} from '@/modules/chat/adapters/exec-driver-factory'
import {
    SessionReaderRegistry,
    type RecoveredMessage,
    type RecoveredRawSource,
    type SessionReader
} from './readers'
import type { OpenclawRpcClient } from '@/modules/chat/adapters/openclaw-rpc-client'
import { buildChatMessageSourceRow } from '../raw-message-source'

export interface RecoveryDiffEntry {
    kind: 'common' | 'local-only' | 'cloud-only'
    localIndex?: number
    cloudIndex?: number
}

interface RecoveryComparison {
    localCount: number
    localMessages: ChatMessage[]
    cloudCount: number
    commonCount: number
    missingCount: number
    missingRecoveredMessages: RecoveredMessage[]
    cloudOnlyCount: number
    diffEntries: RecoveryDiffEntry[]
    degraded: boolean
}

interface RawSourceComparison {
    rawMissingCount: number
    rawMissingRows: NewChatMessageSource[]
    rawDiffEntries: RecoveryDiffEntry[]
    degraded: boolean
}

@Injectable()
export class SessionRecoveryService {
    private readonly log = new Logger(SessionRecoveryService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly repo: ChatRepository,
        private readonly drivers: ExecDriverFactory,
        private readonly readers: SessionReaderRegistry
    ) {}

    async recoverRuntimeSessionRawSources(
        userId: string,
        agentId: string,
        sessionId: string,
        overrideRef?: string
    ): Promise<RuntimeSessionRecoverRawResponse> {
        const { session, agent } = await this.loadContext(
            userId,
            agentId,
            sessionId
        )
        const reader = this.requireReader(agent.framework)
        const handle = await this.recoveryFsOrUnavailable(agent.id)
        const ref = overrideRef ?? session.frameworkSessionRef
        if (!ref)
            throw new BadRequestException({
                code: 'recovery_no_session_ref',
                message:
                    'session has no framework_session_ref; pick a runtime session first'
            })

        const openclawRpc =
            agent.framework === 'openclaw'
                ? await this.drivers.openclawRpcForAgent(agent.id)
                : null
        let result: {
            messages: RecoveredMessage[]
            warnings: string[]
            sourceFile: string | null
        }
        try {
            result = await this.runReader(() =>
                reader.readMessages({
                    fs: handle.fs,
                    agentId: agent.id,
                    frameworkSessionRef: ref,
                    openclawRpc
                })
            )
        } finally {
            openclawRpc?.disconnect()
        }
        if (result.messages.length === 0)
            throw new BadRequestException({
                code: 'recovery_empty',
                message:
                    'no messages could be recovered from local session file'
            })
        const existingRows = await this.repo.listMessages(sessionId)
        const existingMessages = existingRows.map(toApiMessage)
        const comparison = compareRecoveryMessages(
            result.messages,
            existingMessages,
            sessionId
        )
        assertRecoveryMatchesSession({
            session,
            selectedRef: ref,
            cloudMessageCount: existingMessages.length,
            commonCount: comparison.commonCount
        })
        const existingSourceRows = await this.repo.listMessageSources(sessionId)
        const localSourceRows = buildLocalRecoverySourceRows({
            recoveredMessages: result.messages,
            parsedComparison: comparison,
            existingRows,
            sessionId,
            framework: agent.framework,
            runtime: agent.runtime,
            sourceRef: ref,
            sourceFile: result.sourceFile
        })
        const rawComparison = compareRecoveryRawSources(
            localSourceRows,
            existingSourceRows
        )
        const bindingRows = sourceRowsNeedingMessageBinding(
            localSourceRows,
            existingSourceRows,
            rawComparison.rawDiffEntries
        )
        const recoveredRef =
            overrideRef &&
            overrideRef !== session.frameworkSessionRef &&
            comparison.commonCount > 0
                ? overrideRef
                : undefined
        const txResult = await this.repo.upsertMessageSourcesForIdleSession(
            sessionId,
            [...rawComparison.rawMissingRows, ...bindingRows],
            recoveredRef
        )
        if (txResult.conflicted)
            throw new ConflictException({
                code: 'runtime_session_recovery_conflict',
                message:
                    'session received new messages while recovering; retry after the session is idle'
            })
        this.log.log(
            `recovered raw sources session=${sessionId} framework=${agent.framework} missing=${rawComparison.rawMissingCount} upserted=${txResult.upserted} from=${result.sourceFile}`
        )
        return {
            framework: agent.framework,
            sourceFile: result.sourceFile,
            inserted: txResult.upserted,
            rawMissingCount: rawComparison.rawMissingCount,
            recoveredSourceCount: txResult.upserted,
            warnings: result.warnings
        }
    }

    // The agent's whole session list: the cloud sessions this user has for the
    // agent, unioned with the transcripts the framework left on the runtime and
    // joined on framework_session_ref. One bounded scan, no transcript read —
    // opening one of them is viewRuntimeSession.
    //
    // The runtime half degrades instead of failing. A stopped sandbox or an
    // offline daemon used to 503 the whole panel; now the cloud half still
    // answers and `localScan` says the other half is unknown.
    async listAgentSessions(
        userId: string,
        agentId: string
    ): Promise<AgentSessionListResponse> {
        const agent = await this.loadAgentContext(userId, agentId)
        const cloudRows = await this.repo.listSessions(userId, agentId)
        const stats = await this.repo.sessionMessageStats(
            cloudRows.map((row) => row.id)
        )
        const local = await this.scanLocalCandidates(agent)

        const byRef = new Map<string, RuntimeSessionCandidate>()
        for (const candidate of local.candidates)
            byRef.set(candidate.sessionRef, candidate)

        const sessions: AgentSessionListItem[] = []
        const claimed = new Set<string>()
        for (const row of cloudRows) {
            const ref = row.frameworkSessionRef?.trim() || null
            const candidate = ref ? (byRef.get(ref) ?? null) : null
            if (candidate) claimed.add(candidate.sessionRef)
            const stat = stats.get(row.id)
            sessions.push({
                sessionRef: ref,
                cloudSessionId: row.id,
                inCloud: true,
                inLocal: candidate !== null,
                title: row.title ?? candidate?.firstUserMessage ?? null,
                lastAssistantMessage: candidate?.lastAssistantMessage ?? null,
                // The runtime transcript is the fuller record when both exist:
                // a terminal turn lands there first and only reaches the cloud
                // on the next sync.
                lastActiveAt:
                    candidate?.lastActiveAt ??
                    stat?.lastMessageAt?.toISOString() ??
                    row.updatedAt.toISOString(),
                messageCount: candidate?.messageCount ?? stat?.messageCount ?? 0,
                model: candidate?.model ?? null,
                sourceFile: candidate?.sourceFile ?? null
            })
        }

        for (const candidate of local.candidates) {
            if (claimed.has(candidate.sessionRef)) continue
            sessions.push({
                sessionRef: candidate.sessionRef,
                cloudSessionId: null,
                inCloud: false,
                inLocal: true,
                title: candidate.firstUserMessage,
                lastAssistantMessage: candidate.lastAssistantMessage,
                lastActiveAt: candidate.lastActiveAt ?? candidate.timestamp,
                messageCount: candidate.messageCount,
                model: candidate.model,
                sourceFile: candidate.sourceFile
            })
        }

        sessions.sort(byLastActiveDesc)
        return {
            framework: agent.framework,
            runtime: agent.runtime,
            localScan: local.scan,
            sessions,
            warnings: local.warnings
        }
    }

    // Never throws: an unreachable runtime is a degraded list, not a dead one.
    private async scanLocalCandidates(agent: Agent): Promise<{
        candidates: RuntimeSessionCandidate[]
        scan: AgentSessionLocalScan
        warnings: string[]
    }> {
        const reader = this.readers.get(agent.framework)
        if (!reader)
            return { candidates: [], scan: 'unavailable', warnings: [] }
        let openclawRpc: OpenclawRpcClient | null = null
        try {
            const handle = await this.drivers.recoveryFsForAgent(agent.id)
            openclawRpc =
                agent.framework === 'openclaw'
                    ? await this.drivers.openclawRpcForAgent(agent.id)
                    : null
            const candidates = await reader.listCandidates({
                fs: handle.fs,
                agentId: agent.id,
                openclawRpc
            })
            return { candidates, scan: 'ok', warnings: [] }
        } catch (err) {
            this.log.warn(
                `agent session list: runtime scan unavailable for ${agent.id}: ${(err as Error).message}`
            )
            return {
                candidates: [],
                scan: 'unavailable',
                warnings: [`runtime not reachable: ${(err as Error).message}`]
            }
        } finally {
            openclawRpc?.disconnect()
        }
    }

    async viewRuntimeSession(
        userId: string,
        agentId: string,
        sessionId?: string,
        overrideRef?: string,
        includeRaw = false
    ): Promise<RuntimeSessionViewResponse> {
        const agent = await this.loadAgentContext(userId, agentId)
        const session = sessionId
            ? await this.loadOptionalSessionContext(userId, agentId, sessionId)
            : null
        const existingRows = session
            ? await this.repo.listMessages(session.id)
            : []
        const existingMessages = existingRows.map(toApiMessage)
        const existingSourceRows = session
            ? await this.repo.listMessageSources(session.id)
            : []
        const reader = this.requireReader(agent.framework)
        const handle = await this.recoveryFsOrUnavailable(agent.id)
        const openclawRpc =
            agent.framework === 'openclaw'
                ? await this.drivers.openclawRpcForAgent(agent.id)
                : null
        try {
            // A caller that names the session already has the list; scanning
            // every other transcript again would double the runtime work of
            // opening one.
            const candidates = overrideRef
                ? []
                : await this.runReader(() =>
                      reader.listCandidates({
                          fs: handle.fs,
                          agentId: agent.id,
                          openclawRpc
                      })
                  )
            const ref =
                overrideRef ??
                session?.frameworkSessionRef ??
                candidates[0]?.sessionRef ??
                null
            if (!ref) {
                const rawComparison = compareRecoveryRawSources(
                    [],
                    existingSourceRows
                )
                return {
                    framework: agent.framework,
                    runtime: agent.runtime,
                    selectedSessionRef: null,
                    currentSessionRef: session?.frameworkSessionRef ?? null,
                    selectedCloudSessionId: null,
                    sourceFile: null,
                    rawMissingCount: rawComparison.rawMissingCount,
                    rawLocalText: includeRaw ? '' : null,
                    parsedLocalMessages: [],
                    warnings: ['runtime has no session candidates'],
                    needsCandidatePick: true,
                    candidates
                }
            }

            const result = await this.runReader(() =>
                reader.readMessages({
                    fs: handle.fs,
                    agentId: agent.id,
                    frameworkSessionRef: ref,
                    openclawRpc
                })
            )
            const previewSessionId = session?.id ?? `runtime:${ref}`
            const comparison = compareRecoveryMessages(
                result.messages,
                existingMessages,
                previewSessionId
            )
            const selectedCloudSessionId =
                await this.selectedCloudSessionIdForRef(
                    userId,
                    agentId,
                    session,
                    ref,
                    {
                        cloudMessageCount: existingMessages.length,
                        commonCount: comparison.commonCount
                    }
                )
            const localSourceRows = buildLocalRecoverySourceRows({
                recoveredMessages: result.messages,
                parsedComparison: comparison,
                existingRows,
                sessionId: previewSessionId,
                framework: agent.framework,
                runtime: agent.runtime,
                sourceRef: ref,
                sourceFile: result.sourceFile
            })
            const rawComparison = compareRecoveryRawSources(
                localSourceRows,
                existingSourceRows
            )
            const warnings = [...result.warnings]
            if (comparison.degraded || rawComparison.degraded)
                warnings.push(
                    'session too large for an exact diff; missing counts are approximate'
                )
            return {
                framework: agent.framework,
                runtime: agent.runtime,
                selectedSessionRef: ref,
                currentSessionRef: session?.frameworkSessionRef ?? null,
                selectedCloudSessionId,
                sourceFile: result.sourceFile,
                rawMissingCount: rawComparison.rawMissingCount,
                rawLocalText: includeRaw
                    ? renderRawPayloads(localSourceRows)
                    : null,
                parsedLocalMessages: comparison.localMessages,
                warnings,
                needsCandidatePick: false,
                candidates
            }
        } finally {
            openclawRpc?.disconnect()
        }
    }

    async restoreRuntimeSession(
        userId: string,
        agentId: string,
        sessionRef: string
    ): Promise<RuntimeSessionRestoreResponse> {
        const ref = sessionRef.trim()
        if (!ref)
            throw new BadRequestException({
                code: 'runtime_session_ref_required',
                message: 'sessionRef is required'
            })
        const agent = await this.loadAgentContext(userId, agentId)
        const reader = this.requireReader(agent.framework)
        const handle = await this.recoveryFsOrUnavailable(agent.id)
        const openclawRpc =
            agent.framework === 'openclaw'
                ? await this.drivers.openclawRpcForAgent(agent.id)
                : null
        let result: {
            messages: RecoveredMessage[]
            warnings: string[]
            sourceFile: string | null
        }
        try {
            result = await this.runReader(() =>
                reader.readMessages({
                    fs: handle.fs,
                    agentId: agent.id,
                    frameworkSessionRef: ref,
                    openclawRpc
                })
            )
        } finally {
            openclawRpc?.disconnect()
        }
        if (result.messages.length === 0)
            throw new BadRequestException({
                code: 'runtime_session_empty',
                message:
                    'no messages could be restored from runtime session file'
            })

        const now = new Date()
        const sessionId = createObjectId('chatSession')
        const messageCreatedAts = orderedRecoveredMessageDates(
            result.messages,
            now
        )
        const messageRows = result.messages.map(
            (msg, index): NewChatMessage => ({
                id: randomUUID(),
                sessionId,
                role: msg.role,
                contentBlocksJson: collapseTextBlocks(msg.contentBlocks),
                capabilityEventsJson: recoveredMessageMetadata({
                    sourceRef: ref,
                    sourceFile: result.sourceFile,
                    externalId: msg.externalId,
                    model: msg.model ?? null
                }),
                createdAt: messageCreatedAts[index]
            })
        )
        const sourceRows = buildRecoverySourceRowsForMessages({
            recoveredMessages: result.messages,
            messageRows,
            sessionId,
            framework: agent.framework,
            runtime: agent.runtime,
            sourceRef: ref,
            sourceFile: result.sourceFile
        })
        const { session: created, upsertedSources } =
            await this.repo.createSessionWithRecoveredMessages({
                session: {
                    id: sessionId,
                    userId,
                    agentId,
                    title: sanitizeForJsonb(
                        titleFromRecoveredMessages(result.messages)
                    ),
                    frameworkSessionRef: ref,
                    createdAt: now,
                    updatedAt: now
                },
                messages: messageRows,
                sources: sourceRows
            })
        return {
            session: toApiSession(created),
            sourceFile: result.sourceFile,
            restoredMessageCount: messageRows.length,
            recoveredSourceCount: upsertedSources,
            warnings: result.warnings
        }
    }

    async rebuildRuntimeSessionParsedMessages(
        userId: string,
        agentId: string,
        sessionId: string,
        overrideRef?: string
    ): Promise<RuntimeSessionRebuildParsedResponse> {
        const { session, agent } = await this.loadContext(
            userId,
            agentId,
            sessionId
        )
        const ref = overrideRef ?? session.frameworkSessionRef
        if (!ref)
            throw new BadRequestException({
                code: 'rebuild_no_session_ref',
                message:
                    'session has no framework_session_ref; pick a runtime session first'
            })

        const existingRows = await this.repo.listMessages(sessionId)
        if (
            existingRows.length > 0 &&
            !existingRows.every(isRuntimeRecoveredMessage)
        )
            throw new BadRequestException({
                code: 'runtime_session_rebuild_not_recovered',
                message:
                    'parsed rebuild is only supported for sessions imported from runtime session recovery'
            })

        const reader = this.requireReader(agent.framework)
        const handle = await this.recoveryFsOrUnavailable(agent.id)
        const openclawRpc =
            agent.framework === 'openclaw'
                ? await this.drivers.openclawRpcForAgent(agent.id)
                : null
        let result: {
            messages: RecoveredMessage[]
            warnings: string[]
            sourceFile: string | null
        }
        try {
            result = await this.runReader(() =>
                reader.readMessages({
                    fs: handle.fs,
                    agentId: agent.id,
                    frameworkSessionRef: ref,
                    openclawRpc
                })
            )
        } finally {
            openclawRpc?.disconnect()
        }
        if (result.messages.length === 0)
            throw new BadRequestException({
                code: 'runtime_session_empty',
                message:
                    'no messages could be rebuilt from runtime session file'
            })

        const now = new Date()
        const messageCreatedAts = orderedRecoveredMessageDates(
            result.messages,
            now
        )
        const messageRows = result.messages.map(
            (msg, index): NewChatMessage => ({
                id: randomUUID(),
                sessionId,
                role: msg.role,
                contentBlocksJson: collapseTextBlocks(msg.contentBlocks),
                capabilityEventsJson: recoveredMessageMetadata({
                    sourceRef: ref,
                    sourceFile: result.sourceFile,
                    externalId: msg.externalId,
                    model: msg.model ?? null
                }),
                createdAt: messageCreatedAts[index]
            })
        )
        const sourceRows = buildRecoverySourceRowsForMessages({
            recoveredMessages: result.messages,
            messageRows,
            sessionId,
            framework: agent.framework,
            runtime: agent.runtime,
            sourceRef: ref,
            sourceFile: result.sourceFile
        })
        const replaced = await this.repo.replaceSessionMessages(
            sessionId,
            messageRows,
            ref,
            (rows) => rows.every(isRuntimeRecoveredMessage),
            sourceRows
        )
        if (replaced.conflicted)
            throw new ConflictException({
                code: 'runtime_session_rebuild_conflict',
                message:
                    'session received new messages while rebuilding; retry after the session is idle'
            })

        return {
            session: toApiSession({
                ...session,
                frameworkSessionRef: ref,
                updatedAt: now
            }),
            sourceFile: result.sourceFile,
            rebuiltMessageCount: messageRows.length,
            recoveredSourceCount: replaced.upsertedSources,
            warnings: result.warnings
        }
    }

    // Fold a framework CLI's own transcript back into an existing cloud
    // session. The chat view is fed by Postgres, written only during turns the
    // API dispatches; a terminal TUI that resumed the session writes solely to
    // the CLI's local file. This reads that file, diffs it against the current
    // cloud messages, and appends only what the TUI added. Every non-actionable
    // state (no ref, no reader, live turn, nothing new) returns appended:0, so
    // the caller may fire it freely — on every switch back to chat and on
    // session open.
    async syncRuntimeSessionIntoCloud(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<RuntimeSessionSyncResponse> {
        const { session, agent } = await this.loadContext(
            userId,
            agentId,
            sessionId
        )
        const ref = session.frameworkSessionRef?.trim()
        if (!ref)
            return {
                appended: 0,
                recoveredSourceCount: 0,
                skipped: 'no-session-ref',
                warnings: []
            }
        const reader = this.readers.get(agent.framework)
        if (!reader)
            return {
                appended: 0,
                recoveredSourceCount: 0,
                skipped: 'unsupported',
                warnings: []
            }
        // A live turn is already the authoritative writer; appending under it
        // would interleave with the stream it is persisting.
        if (session.inflightMessageId !== null)
            return {
                appended: 0,
                recoveredSourceCount: 0,
                skipped: 'inflight',
                warnings: []
            }

        const existingRows = await this.repo.listMessages(session.id)
        const existingMessages = existingRows.map(toApiMessage)
        const handle = await this.recoveryFsOrUnavailable(agent.id)
        const openclawRpc =
            agent.framework === 'openclaw'
                ? await this.drivers.openclawRpcForAgent(agent.id)
                : null
        let result: {
            messages: RecoveredMessage[]
            warnings: string[]
            sourceFile: string | null
        }
        try {
            result = await this.runReader(() =>
                reader.readMessages({
                    fs: handle.fs,
                    agentId: agent.id,
                    frameworkSessionRef: ref,
                    openclawRpc
                })
            )
        } finally {
            openclawRpc?.disconnect()
        }

        const comparison = compareRecoveryMessages(
            result.messages,
            existingMessages,
            session.id
        )
        // A TUI turn that is still streaming has already written its user line
        // but an assistant entry with no text yet; storing that shell would
        // freeze an empty bubble (the finished turn later diffs as a NEW
        // message, so the shell never fills in). Skip anything that collapses
        // to no content — the next sync picks the finished turn up whole.
        const missing = comparison.missingRecoveredMessages.filter(
            (msg) => collapseTextBlocks(msg.contentBlocks).length > 0
        )
        const warnings = [...result.warnings]
        if (comparison.degraded)
            warnings.push(
                'session too large for an exact diff; some terminal messages may not have synced'
            )
        if (missing.length === 0)
            return {
                appended: 0,
                recoveredSourceCount: 0,
                skipped: null,
                warnings
            }

        // Order the appended messages after everything already stored, then let
        // their own transcript timestamps sequence them among themselves.
        const lastExistingMs = existingRows.reduce(
            (max, row) => Math.max(max, row.createdAt.getTime()),
            0
        )
        const fallback = new Date(Math.max(Date.now(), lastExistingMs + 1))
        const messageCreatedAts = orderedRecoveredMessageDates(
            missing,
            fallback
        )
        const messageRows = missing.map(
            (msg, index): NewChatMessage => ({
                id: randomUUID(),
                sessionId: session.id,
                role: msg.role,
                contentBlocksJson: collapseTextBlocks(msg.contentBlocks),
                capabilityEventsJson: recoveredMessageMetadata({
                    sourceRef: ref,
                    sourceFile: result.sourceFile,
                    externalId: msg.externalId,
                    model: msg.model ?? null
                }),
                createdAt: messageCreatedAts[index]
            })
        )
        const sourceRows = buildRecoverySourceRowsForMessages({
            recoveredMessages: missing,
            messageRows,
            sessionId: session.id,
            framework: agent.framework,
            runtime: agent.runtime,
            sourceRef: ref,
            sourceFile: result.sourceFile
        })
        const appendResult = await this.repo.appendRecoveredMessages(
            session.id,
            messageRows,
            sourceRows
        )
        if (appendResult.conflicted)
            return {
                appended: 0,
                recoveredSourceCount: 0,
                skipped: 'inflight',
                warnings
            }
        this.log.log(
            `synced runtime session into cloud session=${session.id} framework=${agent.framework} appended=${appendResult.appended} from=${result.sourceFile}`
        )
        return {
            appended: appendResult.appended,
            recoveredSourceCount: appendResult.upsertedSources,
            skipped: null,
            warnings
        }
    }

    private async loadContext(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<{
        session: DbChatSession
        agent: Agent
        handle: RecoveryFsHandle | null
    }> {
        const session = await this.repo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || agent.userId !== userId)
            throw new NotFoundException('agent not found')
        return { session, agent, handle: null }
    }

    private async loadOptionalSessionContext(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<DbChatSession> {
        const session = await this.repo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        return session
    }

    private async loadAgentContext(
        userId: string,
        agentId: string
    ): Promise<Agent> {
        const [agent] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent || agent.userId !== userId)
            throw new NotFoundException('agent not found')
        return agent
    }

    private async selectedCloudSessionIdForRef(
        userId: string,
        agentId: string,
        currentSession: DbChatSession | null,
        ref: string,
        match?: {
            cloudMessageCount: number
            commonCount: number
        }
    ): Promise<string | null> {
        const currentRefMatches = currentSession?.frameworkSessionRef === ref
        const currentRefMismatched =
            currentRefMatches &&
            match !== undefined &&
            match.cloudMessageCount > 0 &&
            match.commonCount === 0
        if (currentRefMatches && !currentRefMismatched) return currentSession.id
        const existing = await this.repo.findSessionByFrameworkSessionRef(
            userId,
            agentId,
            ref
        )
        if (currentRefMismatched && existing?.id === currentSession?.id)
            return null
        return existing?.id ?? null
    }

    private requireReader(framework: AgentFramework): SessionReader {
        const reader = this.readers.get(framework)
        if (!reader)
            throw new BadRequestException({
                code: 'recovery_unsupported_framework',
                message: `no recovery reader for framework ${framework}`
            })
        return reader
    }

    // Runtime plumbing throws plain Errors for operational states (pod not
    // running, daemon offline, sprite account drift); surface those as a clean
    // 503 with a stable code instead of an opaque 500.
    private async recoveryFsOrUnavailable(
        agentId: string
    ): Promise<RecoveryFsHandle> {
        try {
            return await this.drivers.recoveryFsForAgent(agentId)
        } catch (err) {
            if (err instanceof HttpException) throw err
            this.log.warn(
                `recovery fs unavailable for agent ${agentId}: ${(err as Error).message}`
            )
            throw new ServiceUnavailableException({
                code: 'recovery_runtime_unavailable',
                message: `agent runtime is not reachable for session recovery: ${(err as Error).message}`
            })
        }
    }

    private async runReader<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn()
        } catch (err) {
            if (err instanceof HttpException) throw err
            this.log.warn(`recovery reader failed: ${(err as Error).message}`)
            throw new ServiceUnavailableException({
                code: 'recovery_runtime_unavailable',
                message: `agent runtime read failed: ${(err as Error).message}`
            })
        }
    }
}

// Newest first, whichever side the timestamp came from. A row with no
// timestamp at all sorts last rather than jumping to the top.
const byLastActiveDesc = (
    a: AgentSessionListItem,
    b: AgentSessionListItem
): number => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '')

export const compareRecoveryMessages = (
    localRecoveredMessages: RecoveredMessage[],
    cloudMessages: ChatMessage[],
    sessionId: string
): RecoveryComparison => {
    const localMessages = localRecoveredMessages.map((r) =>
        toPreviewMessage(r, sessionId)
    )
    const localKeys = localMessages.map(normalizeMessageForCompare)
    const cloudKeys = cloudMessages.map(normalizeMessageForCompare)
    const { entries, degraded } = diffKeys(localKeys, cloudKeys)
    const missingRecoveredMessages: RecoveredMessage[] = []
    let commonCount = 0
    let cloudOnlyCount = 0
    for (const entry of entries) {
        if (entry.kind === 'common') commonCount++
        else if (entry.kind === 'cloud-only') cloudOnlyCount++
        else if (entry.localIndex !== undefined)
            missingRecoveredMessages.push(
                localRecoveredMessages[entry.localIndex]
            )
    }

    return {
        localCount: localMessages.length,
        localMessages,
        cloudCount: cloudMessages.length,
        commonCount,
        missingCount: missingRecoveredMessages.length,
        missingRecoveredMessages,
        cloudOnlyCount,
        diffEntries: entries,
        degraded
    }
}

// A dense LCS matrix is O(local × cloud) memory; a synced long session has
// thousands of rows on BOTH sides, which is exactly when the two sequences are
// nearly identical. Trimming the common prefix/suffix first collapses that
// case to a tiny middle, and the cell cap bounds the adversarial one — past it
// the middle degrades to local-only + cloud-only rather than OOMing the api.
const LCS_MAX_CELLS = 4_000_000

interface DiffOutcome {
    entries: RecoveryDiffEntry[]
    degraded: boolean
}

const diffKeys = (localKeys: string[], cloudKeys: string[]): DiffOutcome => {
    let prefix = 0
    while (
        prefix < localKeys.length &&
        prefix < cloudKeys.length &&
        localKeys[prefix] === cloudKeys[prefix]
    )
        prefix++
    let suffix = 0
    while (
        suffix < localKeys.length - prefix &&
        suffix < cloudKeys.length - prefix &&
        localKeys[localKeys.length - 1 - suffix] ===
            cloudKeys[cloudKeys.length - 1 - suffix]
    )
        suffix++

    const localMid = localKeys.slice(prefix, localKeys.length - suffix)
    const cloudMid = cloudKeys.slice(prefix, cloudKeys.length - suffix)
    const entries: RecoveryDiffEntry[] = []
    for (let i = 0; i < prefix; i++)
        entries.push({ kind: 'common', localIndex: i, cloudIndex: i })

    let degraded = false
    if ((localMid.length + 1) * (cloudMid.length + 1) > LCS_MAX_CELLS) {
        degraded = true
        for (let i = 0; i < localMid.length; i++)
            entries.push({ kind: 'local-only', localIndex: prefix + i })
        for (let j = 0; j < cloudMid.length; j++)
            entries.push({ kind: 'cloud-only', cloudIndex: prefix + j })
    } else {
        const dp = buildLcsMatrix(localMid, cloudMid)
        let i = 0
        let j = 0
        while (i < localMid.length && j < cloudMid.length) {
            if (localMid[i] === cloudMid[j]) {
                entries.push({
                    kind: 'common',
                    localIndex: prefix + i,
                    cloudIndex: prefix + j
                })
                i++
                j++
                continue
            }
            if (dp[i + 1][j] >= dp[i][j + 1]) {
                entries.push({ kind: 'local-only', localIndex: prefix + i })
                i++
            } else {
                entries.push({ kind: 'cloud-only', cloudIndex: prefix + j })
                j++
            }
        }
        while (i < localMid.length) {
            entries.push({ kind: 'local-only', localIndex: prefix + i })
            i++
        }
        while (j < cloudMid.length) {
            entries.push({ kind: 'cloud-only', cloudIndex: prefix + j })
            j++
        }
    }

    for (let s = suffix; s > 0; s--)
        entries.push({
            kind: 'common',
            localIndex: localKeys.length - s,
            cloudIndex: cloudKeys.length - s
        })
    return { entries, degraded }
}

const buildLcsMatrix = (a: string[], b: string[]): number[][] => {
    const rows = a.length + 1
    const cols = b.length + 1
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0))
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] =
                a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
    }
    return dp
}

const normalizeMessageForCompare = (message: ChatMessage): string =>
    stableJson({
        role: message.role,
        contentBlocks: collapseTextBlocks(message.contentBlocks).map(
            normalizeBlockForCompare
        )
    })

const normalizeBlockForCompare = (
    block: ChatContentBlock
): Record<string, unknown> => {
    if (block.type === 'text')
        return { type: 'text', text: normalizeText(block.text) }
    if (block.type === 'thinking')
        return { type: 'thinking', text: normalizeText(block.text) }
    if (block.type === 'tool_call')
        return {
            type: 'tool_call',
            toolName: block.toolName,
            args: block.args
        }
    if (block.type === 'tool_result')
        return {
            type: 'tool_result',
            toolCallId: block.toolCallId,
            result: block.result
        }
    if (block.type === 'context_ref')
        return {
            type: 'context_ref',
            name: block.name,
            path: block.path,
            rootId: block.rootId,
            entryType: block.entryType,
            contentType: block.contentType,
            size: block.size
        }
    if (block.type === 'upload')
        return {
            type: 'upload',
            uploadId: block.uploadId,
            name: block.name,
            contentType: block.contentType,
            size: block.size
        }
    if (
        block.type === 'permission_request' ||
        block.type === 'permission_resolution'
    )
        return block as unknown as Record<string, unknown>
    return {
        type: 'attachment',
        name: block.name,
        path: block.path,
        rootId: block.rootId,
        contentType: block.contentType,
        size: block.size
    }
}

const normalizeText = (text: string): string =>
    text.replace(/\r\n/g, '\n').trim()

const stableJson = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
        .join(',')}}`
}

const buildLocalRecoverySourceRows = (input: {
    recoveredMessages: RecoveredMessage[]
    parsedComparison: RecoveryComparison
    existingRows: DbChatMessage[]
    sessionId: string
    framework: AgentFramework
    runtime: AgentRuntime
    sourceRef: string
    sourceFile: string | null
}): NewChatMessageSource[] => {
    const rows: NewChatMessageSource[] = []
    const messageIdByLocalIndex = new Map<number, string>()
    for (const entry of input.parsedComparison.diffEntries) {
        if (entry.kind !== 'common') continue
        if (entry.localIndex === undefined || entry.cloudIndex === undefined)
            continue
        const existing = input.existingRows[entry.cloudIndex]
        if (existing) messageIdByLocalIndex.set(entry.localIndex, existing.id)
    }
    for (const [localIndex, recovered] of input.recoveredMessages.entries()) {
        rows.push(
            ...buildSourcesForMessage(
                input,
                recovered,
                messageIdByLocalIndex.get(localIndex) ?? null
            )
        )
    }
    return rows
}

const buildRecoverySourceRowsForMessages = (input: {
    recoveredMessages: RecoveredMessage[]
    messageRows: NewChatMessage[]
    sessionId: string
    framework: AgentFramework
    runtime: AgentRuntime
    sourceRef: string
    sourceFile: string | null
}): NewChatMessageSource[] => {
    const rows: NewChatMessageSource[] = []
    for (const [index, recovered] of input.recoveredMessages.entries()) {
        const messageId = input.messageRows[index]?.id ?? null
        rows.push(...buildSourcesForMessage(input, recovered, messageId))
    }
    return rows
}

const assertRecoveryMatchesSession = (input: {
    session: DbChatSession
    selectedRef: string
    cloudMessageCount: number
    commonCount: number
}): void => {
    if (input.cloudMessageCount === 0) return
    if (input.commonCount > 0) return
    throw new BadRequestException({
        code: 'runtime_session_mismatch',
        message:
            input.session.frameworkSessionRef === input.selectedRef
                ? 'selected runtime session does not match the current cloud session; restore it as a new session instead'
                : 'selected runtime session does not match the current cloud session'
    })
}

const sourceRowsNeedingMessageBinding = (
    localRows: NewChatMessageSource[],
    cloudRows: DbChatMessageSource[],
    diffEntries: RecoveryDiffEntry[]
): NewChatMessageSource[] => {
    const rows: NewChatMessageSource[] = []
    for (const entry of diffEntries) {
        if (entry.kind !== 'common') continue
        if (entry.localIndex === undefined || entry.cloudIndex === undefined)
            continue
        const local = localRows[entry.localIndex]
        const cloud = cloudRows[entry.cloudIndex]
        if (!local || !cloud) continue
        if (!local.messageId || cloud.messageId) continue
        if (local.sourceEventKey !== cloud.sourceEventKey) continue
        rows.push(local)
    }
    return rows
}

const buildSourcesForMessage = (
    input: {
        sessionId: string
        framework: AgentFramework
        runtime: AgentRuntime
        sourceRef: string
        sourceFile: string | null
    },
    recovered: RecoveredMessage,
    messageId: string | null
) =>
    recovered.sources.map((source) =>
        buildChatMessageSourceRow({
            sourceKind: 'local_session_recovery',
            sessionId: input.sessionId,
            messageId,
            framework: input.framework,
            runtime: input.runtime,
            source: withRecoverySourceFallbacks(
                source,
                input.sourceRef,
                input.sourceFile
            )
        })
    )

const withRecoverySourceFallbacks = (
    source: RecoveredRawSource,
    sourceRef: string,
    sourceFile: string | null
): RecoveredRawSource => ({
    ...source,
    sourceRef: source.sourceRef ?? sourceRef,
    sourceFile: source.sourceFile ?? sourceFile
})

export const compareRecoveryRawSources = (
    localRows: NewChatMessageSource[],
    cloudRows: DbChatMessageSource[]
): RawSourceComparison => {
    const localKeys = localRows.map(rawCompareKey)
    const cloudKeys = cloudRows.map(rawCompareKey)
    const { entries, degraded } = diffKeys(localKeys, cloudKeys)
    const rawMissingRows: NewChatMessageSource[] = []
    for (const entry of entries) {
        if (entry.kind === 'local-only' && entry.localIndex !== undefined)
            rawMissingRows.push(localRows[entry.localIndex])
    }

    return {
        rawMissingCount: rawMissingRows.length,
        rawMissingRows,
        rawDiffEntries: entries,
        degraded
    }
}

// A cleared row keeps raw_format, raw_sha256 and raw_bytes, so it produces
// the SAME key as the local line it came from and diffs as common. It used to
// get a `cleared:` key of its own, which read as "missing" against every
// local line — fine when clearing followed a message delete, but retention
// clears by age for everyone now, so a session older than the window reported
// N of its lines missing, the viewer offered "Restore raw", the endpoint
// re-imported all N uncapped, and the next sweep cleared them again (the
// upsert leaves created_at alone). The anchor is present and the payload is
// reconstructible; that is not missing. Genuine gaps still diff as
// local-only, and a cleared row that lost its binding is still re-bound via
// sourceRowsNeedingMessageBinding — which is bounded by rows needing binding
// rather than by every cleared row.
const rawCompareKey = (
    row: NewChatMessageSource | DbChatMessageSource
): string => `raw:${row.rawFormat}:${row.rawSha256}:${row.rawBytes}`

const renderRawPayloads = (
    rows: Array<NewChatMessageSource | DbChatMessageSource>
): string =>
    rows.map((row) => row.rawText ?? stableJson(row.rawJson ?? null)).join('\n')

const collapseTextBlocks = (blocks: ChatContentBlock[]): ChatContentBlock[] => {
    const out: ChatContentBlock[] = []
    let buffer = ''
    const flush = (): void => {
        if (buffer) {
            out.push({ type: 'text', text: buffer })
            buffer = ''
        }
    }
    for (const block of blocks) {
        if (block.type === 'text') buffer += block.text
        else {
            flush()
            out.push(block)
        }
    }
    flush()
    return out
}

const toApiMessage = (row: DbChatMessage): ChatMessage => ({
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as ChatMessage['role'],
    contentBlocks: (row.contentBlocksJson as ChatContentBlock[]) ?? [],
    createdAt: row.createdAt.toISOString()
})

const toApiSession = (row: DbChatSession): ChatSessionSummary => ({
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    frameworkSessionRef: row.frameworkSessionRef,
    channel: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
})

const toPreviewMessage = (
    msg: RecoveredMessage,
    sessionId: string
): ChatMessage => ({
    id: `preview:${msg.externalId}`,
    sessionId,
    role: msg.role,
    contentBlocks: collapseTextBlocks(msg.contentBlocks),
    createdAt: msg.timestamp,
    model: msg.role === 'assistant' ? normalizeRecoveredModel(msg.model) : null
})

const titleFromRecoveredMessages = (
    messages: RecoveredMessage[]
): string | null => {
    const firstUser = messages.find((message) => message.role === 'user')
    if (!firstUser) return null
    const text = firstUser.contentBlocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (!text) return null
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

const parseMessageDate = (value: string): Date | null => {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const orderedRecoveredMessageDates = (
    messages: RecoveredMessage[],
    fallback: Date
): Date[] => {
    let lastMs = fallback.getTime() - 1
    return messages.map((message) => {
        const parsedMs =
            parseMessageDate(message.timestamp)?.getTime() ?? fallback.getTime()
        const nextMs = Math.max(parsedMs, lastMs + 1)
        lastMs = nextMs
        return new Date(nextMs)
    })
}

const recoveredMessageMetadata = (input: {
    sourceRef: string
    sourceFile: string | null
    externalId: string
    model?: string | null
}): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {
        recoveredFrom: {
            kind: 'runtime_session',
            sourceRef: input.sourceRef,
            sourceFile: input.sourceFile,
            externalId: input.externalId
        }
    }
    const model = normalizeRecoveredModel(input.model)
    if (model) metadata.model = model
    return metadata
}

const normalizeRecoveredModel = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const isRuntimeRecoveredMessage = (row: DbChatMessage): boolean => {
    const metadata = row.capabilityEventsJson
    if (!isRecord(metadata)) return false
    const recoveredFrom = metadata.recoveredFrom
    return isRecord(recoveredFrom) && recoveredFrom.kind === 'runtime_session'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
