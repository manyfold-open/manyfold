import { SetMetadata } from '@nestjs/common'

export const ALLOW_RUNTIME_SELF_META = 'allow_runtime_self'

// Lets an agent-runtime identity call this endpoint for its OWN agent WITHOUT
// holding any agent_permissions scope. Used by the permission-request flow,
// which by definition runs when the agent is MISSING the scope it wants. The
// guard still resolves the subject agent and asserts it equals the token's
// agentId (self-bound), so a runtime token can only ever act on itself. Pair
// with @SubjectAgentFromPath so the guard has a subject to bind against.
export const AllowRuntimeSelf = (): MethodDecorator =>
    SetMetadata(ALLOW_RUNTIME_SELF_META, true)
