// Wire shapes served by NarraNexus's gateway-token API (GET /manyfold/jobs
// and GET /manyfold/channels) — keep in sync with
// repos/NarraNexus/backend/routes/manyfold_sync.py.

// The origin a mirrored row carries (a MirrorOrigin): which runtime and which
// NarraNexus object it came from, plus the content hash of the last sync.
export type NarraNexusJobOrigin = {
    kind: 'narranexus'
    runtimeId: string
    jobId: string
    contentHash?: string
}

export type NarraNexusChannelOrigin = {
    kind: 'narranexus'
    runtimeId: string
    nxAgentId: string
    contentHash?: string
}

export interface NarraNexusJob {
    job_id: string
    agent_id: string
    title: string | null
    status: string
    job_type: string
    next_run_time: string | null
    updated_at: string | null
}

export interface NarraNexusJobsResponse {
    data?: NarraNexusJob[]
}

export interface NarraNexusChannelBinding {
    provider: string
    agent_id: string
    enabled: boolean
    external_id: string | null
    connection_mode?: string | null
    credentials: Record<string, string | null>
    config: Record<string, unknown>
}

export interface NarraNexusChannelsResponse {
    data?: NarraNexusChannelBinding[]
}
