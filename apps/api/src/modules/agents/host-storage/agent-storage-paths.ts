import type { Agent } from '@manyfold/db'
import { frameworkCapability } from '@manyfold/shared'

// Where a sandbox measurement reads an agent's usage. Whatever shows those
// readings names the paths from here, so a reading and its path always agree.
export const workspacePathFor = (agent: Agent): string =>
    agent.workspacePath || agent.mountPath || '/workspace'

// The framework's home, and what the agent calls it when it has a name.
export const frameworkHome = (
    agent: Agent
): { path: string; label: string | null } | null => {
    if (agent.framework === 'openclaw' || agent.framework === 'hermes')
        return agent.mountPath ? { path: agent.mountPath, label: null } : null
    const config = frameworkCapability(agent.framework).configHome
    if (!config) return null
    const root = agent.fileRoots?.find((item) => item.id === config.rootId)
    return {
        path: root?.path ?? `~/${config.subdir}`,
        label: root?.label ?? config.label
    }
}
