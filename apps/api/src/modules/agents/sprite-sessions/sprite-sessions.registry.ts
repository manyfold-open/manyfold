import { Injectable, Logger } from '@nestjs/common'

export type SpriteSessionKind = 'chat-exec' | 'terminal'

export interface SpriteSessionHandle {
    kind: SpriteSessionKind
    // The machine the session runs on, so a host-level stop can close every
    // session on it whichever agent opened it.
    hostId?: string | null
    close: (reason: string) => void
}

@Injectable()
export class SpritesSessionRegistry {
    private readonly log = new Logger(SpritesSessionRegistry.name)
    private readonly sessions = new Map<string, Set<SpriteSessionHandle>>()

    register(agentId: string, handle: SpriteSessionHandle): () => void {
        const set = this.sessions.get(agentId) ?? new Set()
        set.add(handle)
        this.sessions.set(agentId, set)
        return () => this.unregister(agentId, handle)
    }

    unregister(agentId: string, handle: SpriteSessionHandle): void {
        const set = this.sessions.get(agentId)
        if (!set) return
        set.delete(handle)
        if (set.size === 0) this.sessions.delete(agentId)
    }

    closeForAgent(agentId: string, reason: string): number {
        const set = this.sessions.get(agentId)
        if (!set || set.size === 0) return 0
        const handles = [...set]
        this.log.log(
            `closing ${handles.length} active session(s) for agent=${agentId} reason=${reason}`
        )
        for (const handle of handles) {
            try {
                handle.close(reason)
            } catch (err) {
                this.log.warn(
                    `close failed for agent=${agentId} kind=${handle.kind}: ${(err as Error).message}`
                )
            }
        }
        return handles.length
    }

    closeForHost(hostId: string, reason: string): number {
        let closed = 0
        for (const [agentId, set] of this.sessions) {
            for (const handle of [...set]) {
                if (handle.hostId !== hostId) continue
                try {
                    handle.close(reason)
                    closed++
                } catch (err) {
                    this.log.warn(
                        `close failed for host=${hostId} agent=${agentId} kind=${handle.kind}: ${(err as Error).message}`
                    )
                }
            }
        }
        if (closed > 0)
            this.log.log(
                `closed ${closed} active session(s) on host=${hostId} reason=${reason}`
            )
        return closed
    }

    activeCount(agentId: string): number {
        return this.sessions.get(agentId)?.size ?? 0
    }
}
