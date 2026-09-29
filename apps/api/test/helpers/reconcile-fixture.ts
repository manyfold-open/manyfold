import type {
    AgentRuntimeRow,
    HostDaemonRow,
    RuntimeHostRow
} from '@manyfold/db'
import { AgentReconcileService } from '../../src/modules/agents/reconcile/agent-reconcile.service'
import { contextOf, daemonRow, spritesHostRow } from './runtime-context-fixture'

// AgentReconcileService reads the runtime's machine through
// RuntimeContextService; this build answers that lookup with the host and
// daemon the test chose, for whichever runtime row reconcileRuntime was
// handed (the service re-reads the runtime from the context).
export const reconcilerFor = (
    db: unknown,
    registry: unknown,
    opts: {
        host?: RuntimeHostRow | null
        daemon?: HostDaemonRow | null
    } = {}
): AgentReconcileService => {
    const box: { runtime: AgentRuntimeRow | null } = { runtime: null }
    const host = opts.host === undefined ? spritesHostRow() : opts.host
    const daemon =
        opts.daemon === undefined
            ? host
                ? daemonRow({ hostId: host.id, userId: host.userId })
                : null
            : opts.daemon
    const context = {
        forRuntime: async () =>
            box.runtime
                ? contextOf({ runtime: box.runtime, host, daemon })
                : null
    }
    class Reconciler extends AgentReconcileService {
        override reconcileRuntime(
            runtime: AgentRuntimeRow,
            o?: { serviceReady?: boolean }
        ): Promise<void> {
            box.runtime = runtime
            return super.reconcileRuntime(runtime, o)
        }
    }
    return new Reconciler(db as never, registry as never, context as never)
}
