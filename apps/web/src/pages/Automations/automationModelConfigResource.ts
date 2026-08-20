import type { AgentFramework } from '@manyfold/shared'
import { frameworkUsesModelConfig } from '@/lib/agentModelConfig'

export const automationModelConfigResourceKey = (
    agentId: string | null | undefined,
    framework: AgentFramework | null | undefined
): string | null =>
    agentId && frameworkUsesModelConfig(framework)
        ? `${agentId}:${framework}`
        : null
