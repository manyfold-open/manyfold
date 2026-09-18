import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'
import { TerminalSessionsRepository } from '@/modules/terminal/terminal-sessions.repository'

const ENDED_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_BATCH = 500

// Every instance sweeps; the end() compare-and-set in the holder service
// and the bounded delete make concurrent sweeps safe, so no leader election
// is needed.
@Injectable()
export class TerminalLeaseReaper {
    private readonly log = new Logger(TerminalLeaseReaper.name)

    constructor(
        private readonly holder: TerminalHolderService,
        private readonly terminals: TerminalSessionsRepository
    ) {}

    @Cron(CronExpression.EVERY_MINUTE, { name: 'terminal-lease-reaper' })
    async sweep(): Promise<void> {
        try {
            const reclaimed = await this.holder.reclaimExpired(50)
            if (reclaimed > 0)
                this.log.log(`terminal.lease.sweep reclaimed=${reclaimed}`)
        } catch (err) {
            this.log.warn(
                `terminal.lease.sweep failed: ${(err as Error).message}`
            )
        }
        try {
            const pruned = await this.terminals.deleteEndedBefore(
                new Date(Date.now() - ENDED_ROW_RETENTION_MS),
                PRUNE_BATCH
            )
            if (pruned > 0)
                this.log.log(`terminal.lease.sweep pruned=${pruned}`)
        } catch (err) {
            this.log.warn(
                `terminal.lease.sweep prune failed: ${(err as Error).message}`
            )
        }
    }
}
