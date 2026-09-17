import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { TerminalHolderService } from '@/modules/terminal/terminal-holder.service'

// Every instance sweeps; the end() compare-and-set in the holder service
// makes concurrent sweeps safe, so no leader election is needed.
@Injectable()
export class TerminalLeaseReaper {
    private readonly log = new Logger(TerminalLeaseReaper.name)

    constructor(private readonly holder: TerminalHolderService) {}

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
    }
}
