import { Injectable, Logger } from '@nestjs/common'

// In-process pub/sub with no module dependencies: lets leaf modules (chat,
// runtime-reports) signal cross-cutting listeners (narranexus-sync) without
// creating import cycles through their Nest modules.
export interface AppEvents {
    'chat.turn.finalized': { agentId: string; framework: string }
    'runtime.report.ready': { runtimeId: string; framework: string }
}

type Handler<K extends keyof AppEvents> = (payload: AppEvents[K]) => void

@Injectable()
export class AppEventsService {
    private readonly log = new Logger(AppEventsService.name)
    private readonly handlers = new Map<keyof AppEvents, Set<Handler<never>>>()

    on<K extends keyof AppEvents>(event: K, handler: Handler<K>): void {
        let set = this.handlers.get(event)
        if (!set) {
            set = new Set()
            this.handlers.set(event, set)
        }
        set.add(handler as Handler<never>)
    }

    emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
        const set = this.handlers.get(event)
        if (!set) return
        for (const handler of set) {
            try {
                ;(handler as Handler<K>)(payload)
            } catch (err) {
                this.log.warn(
                    `handler for ${event} threw: ${(err as Error).message}`
                )
            }
        }
    }
}
