import {
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
    agents,
    auditLogs,
    type Database,
    type TerminalSessionRow
} from '@manyfold/db'
import {
    auditAction,
    type ChatSessionChangeDetail,
    type ChatSessionListChangeReason,
    type SessionHolderReleaseResponse
} from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { SessionRecoveryService } from '@/modules/chat/recovery/session-recovery.service'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { SpritesTerminal } from '@/modules/terminal/sprites-terminal'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'
import { TerminalSessionRefsRepository } from '@/modules/terminal/terminal-session-refs.repository'
import type { TerminalResumeOutcome } from '@/modules/terminal/terminal-resume.service'

// Why a terminal stopped, as its driver saw it. Everything but `daemon-lost`
// proves the process is dead or was killed on the way out, so the hold is
// released; a daemon that merely lost its socket may still be running the
// pty, so its terminal keeps the hold until the lease reaper decides.
export type TerminalCloseCause =
    | 'client-closed'
    | 'exit'
    | 'tunnel-failed'
    | 'daemon-lost'

// Session ownership by terminals (ADR-0029 §1, §2): taking the hold as the
// last step of a resume, and every way it is given back — the tunnel
// closing, a reconnecting tab taking over, the user asking from the chat
// view, or the lease running out. Each release stamps the import pending and
// kicks the import.
@Injectable()
export class TerminalHolderService {
    private readonly log = new Logger(TerminalHolderService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly terminals: TerminalSessionsRepository,
        private readonly chatRepo: ChatRepository,
        private readonly recovery: SessionRecoveryService,
        private readonly sprites: SpritesTerminal,
        private readonly daemon: DaemonTerminal,
        @Optional()
        private readonly statusBroadcaster?: SpriteStatusBroadcaster,
        // Same rule; absent, a terminal's end settles no hook-reported refs.
        @Optional()
        private readonly refs?: TerminalSessionRefsRepository
    ) {}

    // The hold is one compare-and-set against no live turn, no other holder
    // and the very ref the resume argv was built from; losing it degrades
    // the terminal to a plain shell with an outcome that says why.
    async acquire(args: {
        terminalId: string
        userId: string
        agentId: string
        sessionId: string
        expectedRef: string
    }): Promise<TerminalResumeOutcome> {
        const acquired = await this.chatRepo.acquireSessionHolder(
            args.sessionId,
            args.terminalId,
            args.expectedRef
        )
        if (acquired) {
            await this.terminals.markHeld(args.terminalId, args.sessionId)
            this.log.log(
                `terminal.holder.acquired terminal=${args.terminalId} session=${args.sessionId}`
            )
            this.emit(args.userId, args.agentId, args.sessionId, 'held')
            return 'applied'
        }
        const state = await this.chatRepo.sessionHolderState(args.sessionId)
        if (state?.holderTerminalId) return 'session-held'
        if (state?.inflightMessageId) return 'turn-in-flight'
        return 'unavailable'
    }

    async finish(terminalId: string, cause: TerminalCloseCause): Promise<void> {
        if (cause === 'daemon-lost') {
            this.log.warn(
                `terminal.daemon_lost terminal=${terminalId}; hold kept until the lease decides`
            )
            return
        }
        const row = await this.terminals.end(
            terminalId,
            cause === 'tunnel-failed' ? 'failed' : 'closed'
        )
        if (!row) return
        await this.releaseAndImport(row)
        this.settleRefsDetached(row)
    }

    // A reconnecting tab names the terminal it replaces: the old process is
    // killed through its handle and its hold released before the new
    // terminal acquires, so an API restart never leaves the user's own
    // reconnect facing `session-held`.
    async supersede(prevTerminalId: string, userId: string): Promise<void> {
        const prev = await this.terminals.findById(prevTerminalId)
        if (!prev || prev.userId !== userId || prev.endedAt) return
        const row = await this.terminals.end(prevTerminalId, 'superseded')
        if (!row) return
        await this.killByHandle(row)
        await this.releaseAndImport(row)
        this.settleRefsDetached(row)
    }

    async releaseByUser(
        userId: string,
        agentId: string,
        sessionId: string
    ): Promise<SessionHolderReleaseResponse> {
        const session = await this.chatRepo.getSession(sessionId, userId)
        if (!session || session.agentId !== agentId)
            throw new NotFoundException('session not found')
        if (!session.holderTerminalId)
            return { released: false, terminalId: null }
        const row = await this.terminals.end(
            session.holderTerminalId,
            'released'
        )
        if (!row)
            return { released: false, terminalId: session.holderTerminalId }
        await this.killByHandle(row)
        const released = await this.releaseAndImport(row)
        this.settleRefsDetached(row)
        return { released, terminalId: row.id }
    }

    // The CLI's own SessionEnd hook, for the session this terminal holds
    // (ADR-0029 §3): the TUI is over but the shell lives on, so the hold is
    // given back without ending the terminal — the same release and import
    // the terminal's close would have run.
    async releaseHeldByHook(
        row: TerminalSessionRow,
        sessionId: string
    ): Promise<boolean> {
        return this.releaseAndImport(
            { ...row, heldSessionId: sessionId },
            undefined,
            'hook-end'
        )
    }

    // Expired leases: the owning tunnel is gone (instance died without its
    // drain, or a daemon never came back). Kill through the handle when there
    // is one, release, and leave an audit row — this is the one release the
    // user did not ask for.
    async reclaimExpired(limit = 50): Promise<number> {
        const candidates = await this.terminals.listExpiredLive(limit)
        let reclaimed = 0
        for (const candidate of candidates) {
            const row = await this.terminals.end(candidate.id, 'reclaimed')
            if (!row) continue
            reclaimed += 1
            await this.killByHandle(row)
            const released = await this.releaseAndImport(row, {
                kind: 'holder-reclaimed'
            })
            this.settleRefsDetached(row)
            this.log.warn(
                `terminal.lease.reclaimed terminal=${row.id} agent=${row.agentId} released=${released}`
            )
            if (!released || !row.heldSessionId) continue
            try {
                await this.db.insert(auditLogs).values({
                    id: randomUUID(),
                    actorId: null,
                    action: auditAction.CHAT_SESSION_HOLDER_RECLAIMED,
                    subject: row.heldSessionId,
                    meta: {
                        terminalId: row.id,
                        agentId: row.agentId,
                        userId: row.userId,
                        leaseExpiresAt: row.leaseExpiresAt.toISOString()
                    }
                })
            } catch (err) {
                this.log.warn(
                    `failed to write audit ${auditAction.CHAT_SESSION_HOLDER_RECLAIMED}/${row.heldSessionId}: ${(err as Error).message}`
                )
            }
        }
        return reclaimed
    }

    private async releaseAndImport(
        row: TerminalSessionRow,
        detail?: ChatSessionChangeDetail,
        reason: string | null = row.endedReason
    ): Promise<boolean> {
        if (!row.heldSessionId) return false
        const { released } = await this.chatRepo.releaseSessionHolder(
            row.heldSessionId,
            row.id
        )
        if (!released) return false
        this.log.log(
            `terminal.holder.released terminal=${row.id} session=${row.heldSessionId} reason=${reason}`
        )
        this.emit(
            row.userId,
            row.agentId,
            row.heldSessionId,
            'released',
            detail
        )
        // Detached on purpose: a closing socket must not wait on a runtime
        // read, and the outcome reaches the user through the import-settled
        // event either way (or stays pending, loudly, for the turn gate).
        void this.recovery
            .settlePendingImport(row.userId, row.agentId, row.heldSessionId)
            .catch((err: Error) =>
                this.log.warn(
                    `import after release failed session=${row.heldSessionId}: ${err.message}`
                )
            )
        return true
    }

    // Sessions the framework's TUI started fresh in this terminal, as its
    // SessionStart hooks reported them (ADR-0029 §3): now that the terminal
    // is over, each non-empty transcript becomes a chat session of its own.
    // Detached like the import — the socket's close does not wait on
    // runtime reads — and every outcome is recorded against the ref.
    private settleRefsDetached(row: TerminalSessionRow): void {
        void this.settleTerminalRefs(row).catch((err: Error) =>
            this.log.warn(
                `terminal.refs.settle_failed terminal=${row.id}: ${err.message}`
            )
        )
    }

    private async settleTerminalRefs(row: TerminalSessionRow): Promise<void> {
        if (!this.refs) return
        const pending = await this.refs.listUnboundUnsettled(row.id)
        for (const ref of pending) {
            const result = await this.recovery.createSessionFromTerminalRef(
                row.userId,
                row.agentId,
                ref.sessionRef
            )
            await this.refs.settle(ref.id, result.outcome, result.sessionId)
            this.log.log(
                `terminal.refs.settled terminal=${row.id} ref=${ref.sessionRef} outcome=${result.outcome}${result.sessionId ? ` session=${result.sessionId}` : ''}`
            )
        }
    }

    // Best effort by design: the row is already ended, so a kill that fails
    // (process long gone, runtime unreachable) is logged, and the release
    // still goes ahead — a hold must not outlive its tunnel.
    private async killByHandle(row: TerminalSessionRow): Promise<void> {
        if (!row.processHandle) {
            this.log.warn(
                `terminal.kill_skipped terminal=${row.id} reason=no-handle`
            )
            return
        }
        const [agent] = await this.db
            .select({
                accountId: agents.accountId,
                spriteName: agents.spriteName,
                daemonId: agents.daemonId
            })
            .from(agents)
            .where(eq(agents.id, row.agentId))
            .limit(1)
        try {
            if (row.runtime === 'sprites') {
                if (!agent?.accountId || !agent.spriteName)
                    throw new Error('agent has no sprite to kill on')
                await this.sprites.killByHandle({
                    accountId: agent.accountId,
                    spriteName: agent.spriteName,
                    handle: row.processHandle
                })
            } else {
                if (!agent?.daemonId)
                    throw new Error('agent has no daemon to close the pty on')
                await this.daemon.closePty(agent.daemonId, row.processHandle)
            }
        } catch (err) {
            this.log.warn(
                `terminal.kill_failed terminal=${row.id} runtime=${row.runtime}: ${(err as Error).message}`
            )
        }
    }

    private emit(
        userId: string,
        agentId: string,
        sessionId: string,
        reason: ChatSessionListChangeReason,
        detail?: ChatSessionChangeDetail
    ): void {
        this.statusBroadcaster?.emitSessionsChanged(userId, {
            type: 'chat-sessions-changed',
            agentId,
            sessionId,
            reason,
            ...(detail ? { detail } : {}),
            at: new Date().toISOString()
        })
    }
}
