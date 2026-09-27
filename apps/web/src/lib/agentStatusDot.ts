import type { RuntimeAvailability } from '@manyfold/shared'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import type { TagTone } from '@/components/Tag'
import { availabilityLabel, availabilityTone } from '@/lib/hostStatus'

// The agent's own lifecycle comes first (a pending or failed agent has no
// machine story yet); a ready agent reads as its derived availability
// (ADR-0036), which already folds in the host's power and daemon presence.
export type AgentStatusFacts = Pick<
    SdkAgent,
    'status' | 'availability' | 'powerState'
>

const RED = 'bg-[#fb7185]'
const AMBER = 'bg-[#f59e0b]'
const GREEN = 'bg-[#22c55e]'
const BLUE = 'bg-[#60a5fa]'
const SLATE = 'bg-[#94a3b8]'

const AVAILABILITY_DOT: Record<RuntimeAvailability, string> = {
    available: GREEN,
    wakeable: BLUE,
    offline: SLATE,
    unavailable: RED
}

const STATUS_LABEL_KEY: Record<SdkAgent['status'], string> = {
    pending: 'web.tags.status.pending',
    ready: 'web.tags.status.ready',
    failed: 'web.tags.status.failed'
}

const STATUS_TONE: Record<Exclude<SdkAgent['status'], 'ready'>, TagTone> = {
    pending: 'warning',
    failed: 'error'
}

export const agentStatusDotClass = (agent: AgentStatusFacts): string => {
    if (agent.status === 'failed') return RED
    if (agent.status === 'pending') return AMBER
    return AVAILABILITY_DOT[agent.availability]
}

export const agentStatusTone = (agent: AgentStatusFacts): TagTone =>
    agent.status === 'ready'
        ? availabilityTone(agent.availability)
        : STATUS_TONE[agent.status]

export const agentStatusDotLabel = (agent: AgentStatusFacts): string =>
    agent.status === 'ready'
        ? availabilityLabel(agent.availability)
        : t(STATUS_LABEL_KEY[agent.status])
