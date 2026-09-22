import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agents,
    type Database,
    type TerminalSessionRefRow,
    type TerminalSessionRow
} from '@manyfold/db'
import type {
    ChatSessionChangeDetail,
    ChatSessionListChangeReason,
    TerminalSessionHookOutcome,
    TerminalSessionHookRequest
} from '@manyfold/shared'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { SessionRecoveryService } from '@/modules/chat/recovery/session-recovery.service'
import { SpriteStatusBroadcaster } from '@/modules/agents/sprite-status/sprite-status-broadcaster'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'
import { TerminalSessionRefsRepository } from '@/modules/terminal/terminal-session-refs.repository'

// A session that started fresh in the terminal is worth keeping for the
// terminal's end; a resume of a ref Manyfold never saw is not — it is the
// user's own history, listed by the runtime-sessions panel already.
const RECORDABLE_SOURCES = new Set<TerminalSessionHookRequest['source']>([
    'startup',
    'clear',
    'fork'
])

// What the CLI's own SessionStart / SessionEnd hooks tell the API about the
// framework sessions in a Manyfold-opened terminal, filed by the ownership
// table of ADR-0029 §3. Everything here is advisory next to the resume-time
// hold: a hook cannot stop a TUI that has already started, so a conflict is
// logged and shown, never fought.
@Injectable()
export class TerminalHookService {
    private readonly log = new Logger(TerminalHookService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly refs: TerminalSessionRefsRepository,
        private readonly chatRepo: ChatRepository,
        private readonly holder: TerminalHolderService,
        private readonly recovery: SessionRecoveryService,
        @Optional()
        private readonly statusBroadcaster?: SpriteStatusBroadcaster,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    async report(
        terminal: TerminalSessionRow,
        body: TerminalSessionHookRequest
    ): Promise<TerminalSessionHookOutcome> {
        const outcome = await this.file(terminal, body)
        this.log.log(
            `terminal.hook terminal=${terminal.id} framework=${body.framework} event=${body.event} source=${body.source} outcome=${outcome}`
        )
        this.telemetry?.event('terminal.hook.report', {
            framework: body.framework,
            event: body.event,
            source: body.source,
            outcome
        })
        return outcome
    }

    private async file(
        terminal: TerminalSessionRow,
        body: TerminalSessionHookRequest
    ): Promise<TerminalSessionHookOutcome> {
        const [agent] = await this.db
            .select({ framework: agents.framework })
            .from(agents)
            .where(eq(agents.id, terminal.agentId))
            .limit(1)
        // Another framework's CLI in this agent's terminal writes a transcript
        // this agent's reader cannot parse; it is not this agent's session.
        if (!agent || agent.framework !== body.framework) return 'ignored'

        const held = await this.heldSession(terminal)
        if (body.event === 'end') return this.fileEnd(terminal, body, held)

        if (held) {
            if (held.ref === body.sessionRef) {
                await this.record(terminal, body, held.sessionId)
                return 'noop'
            }
            // The CLI renamed the session the terminal was opened on: a
            // resume that answered with a new id (the very first start this
            // terminal reports), or a compaction. The session follows the ref
            // once the old ref's tail is safely in.
            const firstStart =
                (await this.refs.countForTerminal(terminal.id)) === 0
            if (firstStart || body.source === 'compact') {
                const moved = await this.moveHeldRef(terminal, held, body)
                if (moved) return 'ref-moved'
                await this.record(terminal, body, null)
                return 'recorded'
            }
            // A new session started while the hold still stands: the TUI
            // that held it is over without its end having arrived (a
            // terminal runs one foreground TUI). Give the hold back first.
            this.log.warn(
                `terminal.hook.stale_hold terminal=${terminal.id} session=${held.sessionId}; released on a new start`
            )
            await this.holder.releaseHeldByHook(terminal, held.sessionId)
        }

        const existing = await this.chatRepo.findSessionByFrameworkSessionRef(
            terminal.userId,
            terminal.agentId,
            body.sessionRef
        )
        if (existing) {
            const state = await this.chatRepo.sessionHolderState(existing.id)
            if (state?.holderTerminalId === terminal.id) {
                await this.record(terminal, body, existing.id)
                return 'noop'
            }
            if (state?.inflightMessageId)
                return this.refuse(terminal, existing.id, 'turn-in-flight')
            if (state?.holderTerminalId)
                return this.refuse(terminal, existing.id, 'held-elsewhere')
            // Acquire (b): the same compare-and-set as the resume path, so a
            // turn that slipped in meanwhile wins and this stays advisory.
            const acquired = await this.holder.acquire({
                terminalId: terminal.id,
                userId: terminal.userId,
                agentId: terminal.agentId,
                sessionId: existing.id,
                expectedRef: body.sessionRef,
                client: terminal.client
            })
            if (acquired === 'applied') {
                await this.record(terminal, body, existing.id)
                return 'acquired'
            }
            return this.refuse(
                terminal,
                existing.id,
                acquired === 'turn-in-flight'
                    ? 'turn-in-flight'
                    : 'held-elsewhere'
            )
        }

        if (!RECORDABLE_SOURCES.has(body.source)) return 'ignored'
        await this.record(terminal, body, null)
        return 'recorded'
    }

    private async fileEnd(
        terminal: TerminalSessionRow,
        body: TerminalSessionHookRequest,
        held: { sessionId: string; ref: string | null } | null
    ): Promise<TerminalSessionHookOutcome> {
        if (held && held.ref === body.sessionRef) {
            await this.refs.recordEnd(terminal.id, body.sessionRef)
            const released = await this.holder.releaseHeldByHook(
                terminal,
                held.sessionId
            )
            // Losing the release means the hold is already gone (the new
            // session's start got there first): nothing left to give back.
            return released ? 'released' : 'noop'
        }
        const known = await this.refs.recordEnd(terminal.id, body.sessionRef)
        return known ? 'noop' : 'ignored'
    }

    // The session this terminal holds right now, if the hold still stands:
    // the row remembers the last session it held even after a hook release,
    // so the chat session's own holder column is what decides.
    private async heldSession(
        terminal: TerminalSessionRow
    ): Promise<{ sessionId: string; ref: string | null } | null> {
        if (!terminal.heldSessionId) return null
        const state = await this.chatRepo.sessionHolderState(
            terminal.heldSessionId
        )
        if (!state || state.holderTerminalId !== terminal.id) return null
        return {
            sessionId: terminal.heldSessionId,
            ref: state.frameworkSessionRef
        }
    }

    private async moveHeldRef(
        terminal: TerminalSessionRow,
        held: { sessionId: string; ref: string | null },
        body: TerminalSessionHookRequest
    ): Promise<boolean> {
        let appended = 0
        try {
            const imported = await this.recovery.importHeldSessionTail(
                terminal.userId,
                terminal.agentId,
                held.sessionId,
                terminal.id
            )
            appended = imported.appended
            // A transcript that exists but could not be read may still hold
            // a tail; moving the ref now would strand it. The new ref is
            // recorded instead, so the terminal's end still keeps it.
            if (imported.transcript === 'unreadable') {
                this.log.warn(
                    `terminal.hook.ref_move_deferred terminal=${terminal.id} session=${held.sessionId}: old transcript unreadable`
                )
                return false
            }
        } catch (err) {
            this.log.warn(
                `terminal.hook.ref_move_deferred terminal=${terminal.id} session=${held.sessionId}: ${(err as Error).message}`
            )
            return false
        }
        const moved = await this.chatRepo.moveHeldSessionRef(
            held.sessionId,
            terminal.id,
            body.sessionRef
        )
        if (!moved) return false
        await this.record(terminal, body, held.sessionId)
        this.log.log(
            `terminal.hook.ref_moved terminal=${terminal.id} session=${held.sessionId} from=${held.ref} to=${body.sessionRef} imported=${appended}`
        )
        if (appended > 0)
            this.emit(terminal, held.sessionId, 'import-settled', {
                kind: 'import-done',
                appended
            })
        return true
    }

    private async refuse(
        terminal: TerminalSessionRow,
        sessionId: string,
        reason: 'turn-in-flight' | 'held-elsewhere'
    ): Promise<TerminalSessionHookOutcome> {
        this.log.warn(
            `terminal.hook.refused terminal=${terminal.id} session=${sessionId} reason=${reason}`
        )
        this.emit(terminal, sessionId, 'terminal-refused', {
            kind: 'terminal-attach-refused',
            reason
        })
        return reason === 'turn-in-flight'
            ? 'refused-turn-in-flight'
            : 'refused-held-elsewhere'
    }

    private record(
        terminal: TerminalSessionRow,
        body: TerminalSessionHookRequest,
        chatSessionId: string | null
    ): Promise<TerminalSessionRefRow> {
        return this.refs.recordStart({
            terminalId: terminal.id,
            framework: body.framework,
            sessionRef: body.sessionRef,
            source: body.source,
            cwd: body.cwd ?? null,
            chatSessionId
        })
    }

    private emit(
        terminal: TerminalSessionRow,
        sessionId: string,
        reason: ChatSessionListChangeReason,
        detail: ChatSessionChangeDetail
    ): void {
        this.statusBroadcaster?.emitSessionsChanged(terminal.userId, {
            type: 'chat-sessions-changed',
            agentId: terminal.agentId,
            sessionId,
            reason,
            detail,
            at: new Date().toISOString()
        })
    }
}
