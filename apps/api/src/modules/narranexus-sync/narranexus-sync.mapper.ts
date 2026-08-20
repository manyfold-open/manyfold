import type { ChannelProviderName } from '@manyfold/shared'
import { createHash } from 'node:crypto'
import type { AutomationOrigin, ChannelOrigin } from '@manyfold/db'
import { manyfoldProviderToNarraNexusChannelProvider } from '@/modules/narranexus/narranexus-paths'
import type {
    NarraNexusChannelBinding,
    NarraNexusJob
} from './narranexus-sync.types'

export const RUN_JOB_PROMPT_VERSION = 'v1'

// Minimum lead time when re-arming an alarm whose source fire time already
// passed while the sandbox was suspended: fire once shortly after wake
// instead of dropping the occurrence or looping on a past timestamp.
const CLAMP_LEAD_MS = 5_000

// Statuses that must never fire even when next_run_time is set. Cooling is
// deliberately NOT here: a cooling job's next_run_time is its retry time and
// the run-job dispatch re-arms it on fire — the mirror fires exactly when
// NarraNexus's own poller would have. running/blocked re-arm through state
// transitions (finalize / module_poller) that trigger a fresh sync.
const UNARMED_STATUSES = new Set([
    'paused',
    'paused_no_quota',
    'blocked',
    'blocked_failed',
    'running',
    'failed'
])

export interface MappedJob {
    jobId: string
    nxAgentId: string
    title: string
    prompt: string
    status: 'active' | 'paused'
    nextRunAt: Date | null
    contentHash: string
    origin: AutomationOrigin
}

export const mapJob = (
    runtimeId: string,
    job: NarraNexusJob,
    now: Date
): MappedJob | null => {
    const jobId = job.job_id?.trim()
    const nxAgentId = job.agent_id?.trim()
    if (!jobId || !nxAgentId) return null
    const rawNextRun = parseIsoDate(job.next_run_time)
    const armed =
        rawNextRun !== null &&
        !UNARMED_STATUSES.has(job.status?.toLowerCase() ?? '')
    const title = job.title?.trim() || jobId
    // Hash raw source fields (not the clamped fire time) so an overdue alarm
    // does not churn on every reconcile.
    const contentHash = sha256Hex(
        [jobId, title, armed ? 'active' : 'paused', job.next_run_time ?? ''].join(
            '|'
        )
    )
    return {
        jobId,
        nxAgentId,
        title,
        prompt: `[[nx:run_job ${jobId} ${RUN_JOB_PROMPT_VERSION}]]`,
        status: armed ? 'active' : 'paused',
        nextRunAt: armed
            ? clampToFuture(rawNextRun, now)
            : null,
        contentHash,
        origin: { kind: 'narranexus', runtimeId, jobId, contentHash }
    }
}

export interface MappedChannel {
    nxAgentId: string
    provider: ChannelProviderName
    label: string
    config: Record<string, unknown>
    credentials: Record<string, unknown>
    externalId: string | null
    contentHash: string
    origin: ChannelOrigin
}

export const mapChannel = (
    runtimeId: string,
    binding: NarraNexusChannelBinding
): MappedChannel | null => {
    const nxAgentId = binding.agent_id?.trim()
    if (!nxAgentId || !binding.enabled) return null
    const mapped = withAgentManagedReply(mapProvider(binding), binding)
    if (!mapped) return null
    // The rendered config is part of the hash, not just the source binding:
    // a mapper change (a new translated key, a changed default) must make
    // existing mirrors stale so the next reconcile applies it. Hashing only the
    // upstream binding would leave every already-synced channel frozen on the
    // shape the mapper produced the day it was created.
    const contentHash = sha256Hex(
        stableStringify({
            provider: binding.provider,
            agent: nxAgentId,
            credentials: binding.credentials,
            config: binding.config,
            mappedConfig: mapped.config
        })
    )
    return {
        nxAgentId,
        ...mapped,
        externalId: binding.external_id?.trim() || null,
        contentHash,
        origin: { kind: 'narranexus', runtimeId, nxAgentId, contentHash }
    }
}

// agentManagedReply is the gate every other channel field sits behind, so it is
// ON unless the binding turns it off: a mirrored channel exists because
// NarraNexus asked for it, and its agent is the one holding the channel tools.
// `config.agent_managed_reply: false` is the per-channel rollback.
//
// Written here rather than inside mapProvider's per-provider cases so it is
// decided once, against the *mapped* Manyfold provider. Providers NarraNexus
// cannot deliver through are degraded to a plain mirror instead of carrying a
// flag channels.service would reject — a rejection there surfaces as a swallowed
// warn in the reconcile loop, i.e. the whole channel silently stops syncing.
const withAgentManagedReply = (
    mapped: MappedProvider | null,
    binding: NarraNexusChannelBinding
): MappedProvider | null => {
    if (!mapped) return null
    const deliverable = manyfoldProviderToNarraNexusChannelProvider(
        mapped.provider,
        { mirrored: true }
    )
    if (!deliverable || !truthy(binding.config?.agent_managed_reply, true))
        return mapped
    return { ...mapped, config: { ...mapped.config, agentManagedReply: true } }
}

// Absent means on. Real JSON booleans are what we ask for, but a config that
// travelled through a form or an env var arrives as a string, and reading
// "false" as truthy would silently disable the rollback.
const truthy = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase()
        if (['false', '0', 'no', 'off', ''].includes(v)) return false
        if (['true', '1', 'yes', 'on'].includes(v)) return true
    }
    return fallback
}

type MappedProvider = Pick<
    MappedChannel,
    'provider' | 'label' | 'config' | 'credentials'
>

const mapProvider = (
    binding: NarraNexusChannelBinding
): MappedProvider | null => {
    const creds = binding.credentials ?? {}
    const config = binding.config ?? {}
    switch (binding.provider) {
        case 'telegram': {
            if (!creds.bot_token) return null
            return {
                provider: 'telegram',
                label: channelLabel('Telegram', config.bot_username),
                config: {},
                credentials: { botToken: creds.bot_token }
            }
        }
        case 'discord': {
            if (!creds.bot_token) return null
            return {
                provider: 'discord',
                label: channelLabel('Discord', config.bot_username),
                config: {},
                credentials: { botToken: creds.bot_token }
            }
        }
        case 'lark': {
            const appId = stringOrNull(config.app_id)
            if (!appId || !creds.app_secret) return null
            // With the bot's display name we keep @-mention gating in groups
            // (register() then upgrades to the stable botOpenId); without it
            // we fall back to mention-all so the channel is created instead of
            // rejected by Lark's strict validation — the contract NarraNexus
            // documents when it sends config.bot_name (empty until its bind
            // flow captures it).
            const botName = stringOrNull(config.bot_name)
            return {
                provider: 'lark',
                label: channelLabel('Lark', appId),
                config: {
                    appId,
                    subscriptionMode: 'websocket',
                    appRegion: config.brand === 'lark' ? 'lark' : 'feishu',
                    ...(botName
                        ? { botName, mentionOnly: true }
                        : { mentionOnly: false })
                },
                credentials: { appSecret: creds.app_secret }
            }
        }
        case 'wechat': {
            if (!creds.bot_token) return null
            return {
                provider: 'weixin',
                label: channelLabel('WeChat', config.bot_wx_id),
                config: {},
                credentials: {
                    botToken: creds.bot_token,
                    ...(creds.base_url ? { baseUrl: creds.base_url } : {})
                }
            }
        }
        case 'narramessenger': {
            // Only direct-Matrix bindings translate; the NarraMessenger
            // gateway transport has no Manyfold provider.
            if (binding.connection_mode !== 'matrix') return null
            const homeserver = stringOrNull(config.matrix_homeserver_url)
            if (!homeserver || !creds.matrix_access_token) return null
            return {
                provider: 'matrix',
                label: channelLabel('Matrix', config.matrix_user_id),
                config: { homeserver },
                credentials: { accessToken: creds.matrix_access_token }
            }
        }
        // Slack is deliberately unsupported: NarraNexus runs Socket Mode and
        // never holds the signing secret Manyfold's Events API webhook needs.
        default:
            return null
    }
}

const channelLabel = (providerName: string, detail: unknown): string => {
    const suffix = stringOrNull(detail)
    return suffix
        ? `NarraNexus ${providerName} (${suffix})`
        : `NarraNexus ${providerName}`
}

const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const parseIsoDate = (value: string | null | undefined): Date | null => {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const clampToFuture = (date: Date, now: Date): Date =>
    date.getTime() > now.getTime() + CLAMP_LEAD_MS
        ? date
        : new Date(now.getTime() + CLAMP_LEAD_MS)

export const sha256Hex = (value: string): string =>
    createHash('sha256').update(value).digest('hex')

const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value)
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(',')}]`
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
}
