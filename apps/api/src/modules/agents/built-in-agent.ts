import type { Agent, AgentRuntimeRow } from '@manyfold/db'
import type { RuntimeTarget } from '@/modules/agents/adapters/agent-adapter'

// The agent a service framework always has and never deletes: the profile
// its gateway runs by default. On a sandbox or a cloud computer it is the
// runtime's first agent, stored under this name (ADR-0040).
export const serviceBuiltInProfile = (
    target: Pick<RuntimeTarget, 'placement'> & {
        runtime: Pick<AgentRuntimeRow, 'framework'>
    }
): string | null => {
    if (target.placement !== 'sprites' && target.placement !== 'k8s')
        return null
    if (target.runtime.framework === 'hermes') return 'default'
    if (target.runtime.framework === 'openclaw') return 'main'
    return null
}

export const isBuiltInProfileAgent = (
    target: Parameters<typeof serviceBuiltInProfile>[0],
    agent: Pick<Agent, 'internalId'>
): boolean => agent.internalId === serviceBuiltInProfile(target)
