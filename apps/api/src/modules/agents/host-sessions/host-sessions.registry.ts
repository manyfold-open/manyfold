import { Injectable, Logger } from '@nestjs/common'

// The terminals open through this instance, by the machine they run on, so
// stopping a sandbox can let every tab on it go: each one holds its machine
// awake for as long as it is attached (ADR-0038).
@Injectable()
export class HostSessionRegistry {
    private readonly log = new Logger(HostSessionRegistry.name)
    private readonly sessions = new Map<string, Set<(reason: string) => void>>()

    register(hostId: string, close: (reason: string) => void): () => void {
        const set = this.sessions.get(hostId) ?? new Set()
        set.add(close)
        this.sessions.set(hostId, set)
        return () => {
            set.delete(close)
            if (set.size === 0 && this.sessions.get(hostId) === set)
                this.sessions.delete(hostId)
        }
    }

    closeForHost(hostId: string, reason: string): number {
        const closes = [...(this.sessions.get(hostId) ?? [])]
        for (const close of closes) {
            try {
                close(reason)
            } catch (err) {
                this.log.warn(
                    `close failed for host=${hostId}: ${(err as Error).message}`
                )
            }
        }
        if (closes.length > 0)
            this.log.log(
                `closed ${closes.length} active session(s) on host=${hostId} reason=${reason}`
            )
        return closes.length
    }
}
