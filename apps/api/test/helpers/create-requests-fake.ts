import type { FastifyReply } from 'fastify'
import type { AgentCreateRequestsService } from '../../src/modules/agents/create-requests/agent-create-requests.service'

// Claims every name and runs the create straight away, for tests about what
// the create itself does.
export const passThroughCreateRequests = (): AgentCreateRequestsService =>
    ({
        fingerprint: () => 'fixture',
        claim: async () => ({ kind: 'run', request: { id: 'acq_fixture' } }),
        execute: async (
            _claim: unknown,
            emitter: unknown,
            create: (emitter: unknown) => Promise<unknown>
        ) => create(emitter ?? { step: () => undefined })
    }) as never

// A reply for handlers that only set a header on it.
export const headerOnlyReply = (): FastifyReply =>
    ({ header: () => undefined }) as never
