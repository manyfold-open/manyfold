import type { AgentSettingsSectionId } from '@/lib/agentSettingsSections'

// Every "Agent settings" entry point routes through here, so the area's shape
// is decided in one place.
export const agentSettingsPath = (
    agentId: string,
    section: AgentSettingsSectionId = 'overview'
): string => `/agents/${agentId}/settings/${section}`
