import { narraNexusBaseWorkingPath } from '@manyfold/shared'
import type {
    AgentRuntime,
    ChannelProviderName
} from '@manyfold/shared'

export const NARRANEXUS_USER_ID_MAX_LEN = 60

export const manyfoldUserToNarraNexusUserId = (mfUserId: string): string => {
    if (mfUserId.startsWith('mf_')) return mfUserId.slice(0, NARRANEXUS_USER_ID_MAX_LEN + 3)
    const sanitised = mfUserId
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .slice(0, NARRANEXUS_USER_ID_MAX_LEN)
    return `mf_${sanitised}`
}

// A SEED, not an answer. The per-agent workspace layout belongs to NarraNexus
// and has already changed once under us; the authoritative value comes from
// `GET /manyfold/agents/{id}/files/roots` (see FilesContextBuilder, which also
// writes the resolved path back onto the agent row).
//
// This exists only for the one moment the gateway cannot be asked: sandbox
// provisioning, where Manyfold has to name a workspace before the NarraNexus
// agent exists. Never use it to address a file.
export const narraNexusSeedWorkspacePath = (
    runtimeKind: AgentRuntime,
    agentInternalId: string,
    mfUserId: string
): string =>
    `${narraNexusBaseWorkingPath(runtimeKind)}/${agentInternalId}_${manyfoldUserToNarraNexusUserId(mfUserId)}`

// channel_provider values NarraNexus maps to a WorkingSource (see
// backend/routes/manyfold_sync.py _PROVIDER_WORKING_SOURCE). An unmapped
// Manyfold provider returns null: the forwarded turn must then stay a plain
// MANYFOLD/owner-chat turn, never an agent-managed channel turn.
export type NarraNexusChannelProvider =
    | 'lark'
    | 'slack'
    | 'telegram'
    | 'wechat'
    | 'discord'
    | 'narramessenger'

const MANYFOLD_TO_NARRANEXUS_CHANNEL_PROVIDER: Partial<
    Record<ChannelProviderName, NarraNexusChannelProvider>
> = {
    lark: 'lark',
    slack: 'slack',
    telegram: 'telegram',
    discord: 'discord',
    weixin: 'wechat'
}

export interface NarraNexusProviderMappingOptions {
    // The channel row carries a narranexus origin, i.e. the sync mapper created
    // it by translating one of our own bindings.
    mirrored?: boolean
}

// matrix is the one provider whose meaning depends on where the row came from:
// a mirrored row is NarraMessenger (mapChannel translates a narramessenger
// binding into a matrix row), while a user's own Matrix connector is a generic
// transport NarraNexus has no WorkingSource for. Mapping it unconditionally
// would send user-built Matrix channels into narramessenger semantics, where
// authorize fails closed against channel_narramessenger_credentials and the
// whole channel is rejected.
export const manyfoldProviderToNarraNexusChannelProvider = (
    provider: ChannelProviderName,
    options: NarraNexusProviderMappingOptions = {}
): NarraNexusChannelProvider | null => {
    if (provider === 'matrix')
        return options.mirrored === true ? 'narramessenger' : null
    return MANYFOLD_TO_NARRANEXUS_CHANNEL_PROVIDER[provider] ?? null
}
