import { agents, jsonbMerge, type Agent, type Database } from '@manyfold/db'
import { eq } from 'drizzle-orm'
import type {
    DaemonConfigAttempt,
    DaemonConfigSnapshot
} from '../../src/modules/daemon/daemon-config-delivery.service'

// Legacy projection tests replace admission only. Real ownership, leases and
// protected disk commits are exercised by daemon-config-reconcile.pg.test.ts.
export const legacyConfigDelivery = (db: Pick<Database, 'update'>) => ({
    deliver: async <T>(
        agent: Agent,
        work: (
            snapshot: DaemonConfigSnapshot,
            attempt: DaemonConfigAttempt
        ) => Promise<T>
    ) =>
        work(
            {
                agent,
                runtime: { homeDir: '/home/cy' } as never,
                connections: [],
                revision: () => 'fixture-revision'
            },
            {
                generation: '1',
                holderId: 'fixture',
                signal: new AbortController().signal,
                protectedWrites: false,
                expectedConnection: undefined,
                assertCurrent: async () => {},
                publish: async (_source, _kind, patch) => {
                    await db
                        .update(agents)
                        .set({ extras: jsonbMerge(agents.extras, patch) })
                        .where(eq(agents.id, agent.id))
                    return true
                }
            }
        )
})
