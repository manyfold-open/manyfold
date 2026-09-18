import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit
} from '@nestjs/common'
import type { DaemonOwnedTerminal } from '@manyfold/shared'
import { DaemonHostService } from '@/modules/daemon/daemon-host.service'
import { DaemonTerminal } from '@/modules/terminal/daemon-terminal'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'

// A row is written before the daemon can know its terminal, and a terminal
// is spawned before its first inventory goes out; a report that crosses
// either must not read the other side as gone.
export const INVENTORY_GRACE_MS = 60_000

// The daemon's word on the terminals it owns (ADR-0029 §6) replaces the
// tunnel lease as their proof of life: every live row the inventory names
// has its lease renewed, a row it no longer names is ended (the process is
// gone, so the hold is released), and a terminal it names that no live row
// claims is closed, since nothing will attach to it again.
@Injectable()
export class TerminalInventoryService implements OnModuleInit, OnModuleDestroy {
    private readonly log = new Logger(TerminalInventoryService.name)
    private stop: (() => void) | null = null

    constructor(
        private readonly hosts: DaemonHostService,
        private readonly terminals: TerminalSessionsRepository,
        private readonly holder: TerminalHolderService,
        private readonly daemon: DaemonTerminal
    ) {}

    onModuleInit(): void {
        this.stop = this.hosts.onTerminalInventory((daemonId, terminals) => {
            void this.reconcile(daemonId, terminals).catch((err: Error) =>
                this.log.warn(
                    `terminal.inventory.failed daemon=${daemonId}: ${err.message}`
                )
            )
        })
    }

    onModuleDestroy(): void {
        this.stop?.()
        this.stop = null
    }

    async reconcile(
        daemonId: string,
        terminals: DaemonOwnedTerminal[],
        now = Date.now()
    ): Promise<{ renewed: number; ended: number; closed: number }> {
        const rows = await this.terminals.listLiveOwnedByDaemon(daemonId)
        const reported = new Set(terminals.map((t) => t.terminalId))
        const renewed = await this.terminals.renewLeases(
            rows.filter((row) => reported.has(row.id)).map((row) => row.id)
        )
        let ended = 0
        for (const row of rows) {
            if (reported.has(row.id)) continue
            if (now - row.createdAt.getTime() < INVENTORY_GRACE_MS) continue
            if (await this.holder.endGone(row)) ended += 1
        }
        const live = new Set(rows.map((row) => row.id))
        let closed = 0
        for (const terminal of terminals) {
            if (live.has(terminal.terminalId)) continue
            const startedAt = Date.parse(terminal.startedAt)
            if (
                Number.isFinite(startedAt) &&
                now - startedAt < INVENTORY_GRACE_MS
            )
                continue
            try {
                await this.daemon.closePty(daemonId, terminal.terminalId)
                closed += 1
            } catch (err) {
                this.log.warn(
                    `terminal.inventory.close_failed daemon=${daemonId} terminal=${terminal.terminalId}: ${(err as Error).message}`
                )
            }
        }
        if (ended > 0 || closed > 0)
            this.log.log(
                `terminal.inventory daemon=${daemonId} reported=${terminals.length} renewed=${renewed} ended=${ended} closed=${closed}`
            )
        return { renewed, ended, closed }
    }
}
