import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import type { TagTone } from '@/components/Tag'
import { TONE_DOT, availabilityLabel, availabilityTone } from '@/lib/hostStatus'

// The agent's own lifecycle comes first (a pending or failed agent has no
// machine story yet); a ready agent reads as its derived availability
// (ADR-0037), which already folds in the host's power and daemon presence.
export type AgentStatusFacts = Pick<
    SdkAgent,
    'status' | 'availability' | 'powerState'
>

const STATUS_LABEL_KEY: Record<SdkAgent['status'], string> = {
    pending: 'web.tags.status.pending',
    ready: 'web.tags.status.ready',
    failed: 'web.tags.status.failed'
}

// The same tones, and so the same colours, as the machine under Settings ›
// Runtimes (hostStatus); a pending agent is in progress, as a host being
// provisioned is.
const agentStatusTone = (agent: AgentStatusFacts): TagTone =>
    agent.status === 'failed'
        ? 'error'
        : agent.status === 'pending'
          ? 'info'
          : availabilityTone(agent.availability)

export const agentStatusDotClass = (agent: AgentStatusFacts): string =>
    TONE_DOT[agentStatusTone(agent)]

export const agentStatusDotLabel = (agent: AgentStatusFacts): string =>
    agent.status === 'ready'
        ? availabilityLabel(agent.availability, agent.powerState)
        : t(STATUS_LABEL_KEY[agent.status])
