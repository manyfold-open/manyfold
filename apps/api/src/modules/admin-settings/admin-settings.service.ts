import {
    DEFAULT_A2A_TURN_TIMEOUTS,
    DEFAULT_AUTOMATION_RETENTION,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    DEFAULT_CLI_MINIMUM_VERSION,
    DEFAULT_FRAMEWORK_DEFAULT_VERSIONS,
    allFeatureToggles,
    MAX_A2A_ASYNC_TIMEOUT_SECONDS,
    MAX_A2A_BLOCKING_TIMEOUT_SECONDS,
    MAX_AUTOMATION_RETENTION_DAYS,
    MAX_CHAT_EXEC_TIMEOUT_SECONDS,
    MIN_A2A_TURN_TIMEOUT_SECONDS,
    agentFramework,
    blockedVersionMessage,
    blockedVersionRangesFor,
    compareCliSemver,
    compareSemverPrecedence,
    configurableFrameworkRuntimeDefaults,
    findBlockedVersionRange,
    frameworkPrereleaseAllowed,
    frameworkRepoCandidates,
    frameworkUpgradeMode,
    isFeatureToggleKey,
    isPrereleaseVersion,
    parseCliSemver,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type {
    A2aTurnTimeoutsSettings,
    AgentFramework,
    AutomationRetentionSettings,
    BuiltinSkillRepoEntry,
    BuiltinSkillRepoInput,
    BuiltinSkillReposSettings,
    ChatExecTimeoutsSettings,
    CliMinimumVersionSettings,
    FeatureToggleKey,
    FeatureToggleView,
    FeatureTogglesView,
    FrameworkBlockedVersionRange,
    FrameworkDefaultVersionsSettings,
    FrameworkRuntimeChoice,
    FrameworkRuntimeDefaultsSettings,
    ResolvedChatExecTimeoutMs,
    SpritesVendorCapacityView,
    SpritesWholesaleCapSettings,
    UpdateA2aTurnTimeoutsSettingsBody,
    UpdateAutomationRetentionSettingsBody,
    UpdateChatExecTimeoutsSettingsBody,
    UpdateCliMinimumVersionSettingsBody,
    UpdateFrameworkDefaultVersionsSettingsBody,
    UpdateFrameworkRuntimeDefaultsSettingsBody,
    UpdateSpritesWholesaleCapSettingsBody
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    Inject,
    Injectable,
    ServiceUnavailableException
} from '@nestjs/common'
import { eq, sql } from 'drizzle-orm'
import { appSettings, auditLogs, type Database } from '@manyfold/db'
import {
    effectiveSpritesCap,
    parseVendorObservation,
    shouldRecordObservation,
    vendorCapacityView,
    type SpritesEffectiveCap,
    type SpritesVendorAccountObservation
} from './sprites-vendor-caps'
import { DRIZZLE } from '@/db/tokens'
import {
    DEFAULT_SKILL_REPOS,
    PLATFORM_DEFAULT_SKILL_IDS,
    assertSafeGitHubOwner,
    assertSafeGitHubRepo,
    assertSafeGitRef
} from '@/modules/skills/skill-utils'

export const BUILTIN_SKILL_REPOS_SETTING_KEY = 'builtin_skill_repos'

// Skill ids auto-installed on every new agent (deliberate rollout: empty until
// the first-party skill is published and this is seeded). See agent provisioning.
export const DEFAULT_AGENT_SKILLS_SETTING_KEY = 'default_agent_skills'

export const SPRITES_WHOLESALE_CAP_SETTING_KEY = 'sprites_wholesale_cap'
export const DEFAULT_SPRITES_WHOLESALE_ACTIVE_CAP = 10
export const DEFAULT_SPRITES_WHOLESALE_SOFT_PCT = 90
const WHOLESALE_CAP_CACHE_TTL_MS = 60_000

// Machine-written mirror of what sprites.dev reports per account. Deliberately a
// SEPARATE key from sprites_wholesale_cap: that one is admin policy (intent),
// this one is vendor truth (observation), and blending them into one row would
// make the status-sync writer fight the admin PUT.
export const SPRITES_VENDOR_CAPS_SETTING_KEY = 'sprites_vendor_caps'
const VENDOR_CAPS_CACHE_TTL_MS = 60_000

export const CHAT_EXEC_TIMEOUTS_SETTING_KEY = 'chat_exec_timeouts'
const CHAT_EXEC_TIMEOUTS_CACHE_TTL_MS = 60_000

export const AUTOMATION_RETENTION_SETTING_KEY = 'automation_retention_days'
const AUTOMATION_RETENTION_CACHE_TTL_MS = 60_000

export const A2A_TURN_TIMEOUTS_SETTING_KEY = 'a2a_turn_timeouts'
const A2A_TURN_TIMEOUTS_CACHE_TTL_MS = 60_000

export const CLI_MINIMUM_VERSION_SETTING_KEY = 'cli_minimum_version'
const CLI_MINIMUM_VERSION_CACHE_TTL_MS = 60_000

export const FRAMEWORK_RUNTIME_DEFAULTS_SETTING_KEY =
    'framework_runtime_defaults'
const FRAMEWORK_RUNTIME_DEFAULTS_CACHE_TTL_MS = 60_000

export const FRAMEWORK_DEFAULT_VERSIONS_SETTING_KEY =
    'framework_default_versions'
const FRAMEWORK_DEFAULT_VERSIONS_CACHE_TTL_MS = 60_000

export const FEATURE_TOGGLES_SETTING_KEY = 'feature_toggles'
const FEATURE_TOGGLES_CACHE_TTL_MS = 60_000


const FRAMEWORK_RUNTIME_CHOICES: ReadonlySet<FrameworkRuntimeChoice> = new Set([
    'sprites',
    'k8s'
])

const ALL_AGENT_FRAMEWORKS: ReadonlySet<AgentFramework> = new Set(
    Object.values(agentFramework) as AgentFramework[]
)

const CONFIGURABLE_FRAMEWORK_RUNTIME_DEFAULTS: ReadonlySet<AgentFramework> =
    new Set(configurableFrameworkRuntimeDefaults)

@Injectable()
export class AdminSettingsService {
    private wholesaleCapCache: {
        value: SpritesWholesaleCapSettings
        expiresAt: number
    } | null = null
    private vendorCapsCache: {
        value: Record<string, SpritesVendorAccountObservation>
        expiresAt: number
    } | null = null
    private chatExecTimeoutsCache: {
        value: ChatExecTimeoutsSettings
        expiresAt: number
    } | null = null
    private automationRetentionCache: {
        value: AutomationRetentionSettings
        expiresAt: number
    } | null = null
    // value stays null when no row exists — "unset" is meaningful to A2aService
    // (legacy env fallback applies), so the null itself is cached too.
    private a2aTurnTimeoutsCache: {
        value: A2aTurnTimeoutsSettings | null
        expiresAt: number
    } | null = null
    private cliMinimumVersionCache: {
        value: CliMinimumVersionSettings
        expiresAt: number
    } | null = null
    private frameworkRuntimeDefaultsCache: {
        value: FrameworkRuntimeDefaultsSettings
        expiresAt: number
    } | null = null
    private frameworkDefaultVersionsCache: {
        value: FrameworkDefaultVersionsSettings
        expiresAt: number
    } | null = null
    private featureTogglesCache: {
        value: Record<string, boolean>
        expiresAt: number
    } | null = null

    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    async getBuiltinSkillRepos(): Promise<BuiltinSkillReposSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, BUILTIN_SKILL_REPOS_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return { repos: this.readBuiltinSkillRepos(row?.valueJson) }
    }

    async getDefaultAgentSkills(): Promise<{ skillIds: string[] }> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, DEFAULT_AGENT_SKILLS_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        // No explicit setting → default-install the platform skills. An admin can
        // opt out by saving an explicit (possibly empty) list.
        if (!row) return { skillIds: [...PLATFORM_DEFAULT_SKILL_IDS] }
        const raw = row.valueJson?.skillIds
        const skillIds = Array.isArray(raw)
            ? raw.filter((v): v is string => typeof v === 'string')
            : []
        return { skillIds }
    }

    async updateBuiltinSkillRepos(
        actorId: string,
        repos: BuiltinSkillRepoInput[]
    ): Promise<BuiltinSkillReposSettings> {
        const normalized = this.normalizeBuiltinSkillRepos(repos)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: BUILTIN_SKILL_REPOS_SETTING_KEY,
                    valueJson: { repos: normalized },
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: { repos: normalized },
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        await this.audit(
            actorId,
            'admin.settings.builtin_skill_repos.update',
            { count: normalized.length },
            BUILTIN_SKILL_REPOS_SETTING_KEY
        )
        return { repos: normalized }
    }

    async getSpritesWholesaleCap(): Promise<SpritesWholesaleCapSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, SPRITES_WHOLESALE_CAP_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readWholesaleCap(row?.valueJson)
    }

    async updateSpritesWholesaleCap(
        actorId: string,
        input: UpdateSpritesWholesaleCapSettingsBody
    ): Promise<SpritesWholesaleCapSettings> {
        const normalized = this.normalizeWholesaleCap(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: SPRITES_WHOLESALE_CAP_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.wholesaleCapCache = null
        await this.audit(
            actorId,
            'admin.settings.sprites_wholesale_cap.update',
            normalized as unknown as Record<string, unknown>,
            SPRITES_WHOLESALE_CAP_SETTING_KEY
        )
        return normalized
    }

    async getCachedSpritesWholesaleCap(): Promise<SpritesWholesaleCapSettings> {
        if (
            this.wholesaleCapCache &&
            this.wholesaleCapCache.expiresAt > Date.now()
        )
            return this.wholesaleCapCache.value
        const value = await this.getSpritesWholesaleCap()
        this.wholesaleCapCache = {
            value,
            expiresAt: Date.now() + WHOLESALE_CAP_CACHE_TTL_MS
        }
        return value
    }

    // The cap admission actually enforces: admin policy clamped to what
    // sprites.dev says it will serve. Read on the reserveActiveSlot slow path,
    // so both inputs come from 60s caches.
    async getCachedSpritesEffectiveCap(): Promise<SpritesEffectiveCap> {
        const [policy, observations] = await Promise.all([
            this.getCachedSpritesWholesaleCap(),
            this.getCachedSpritesVendorCaps()
        ])
        return effectiveSpritesCap(policy, observations, Date.now())
    }

    async getSpritesVendorCapacity(): Promise<SpritesVendorCapacityView> {
        const [policy, observations] = await Promise.all([
            this.getSpritesWholesaleCap(),
            this.readSpritesVendorCaps()
        ])
        return vendorCapacityView(policy, observations, Date.now())
    }

    async getCachedSpritesVendorCaps(): Promise<
        Record<string, SpritesVendorAccountObservation>
    > {
        if (this.vendorCapsCache && this.vendorCapsCache.expiresAt > Date.now())
            return this.vendorCapsCache.value
        const value = await this.readSpritesVendorCaps()
        this.vendorCapsCache = {
            value,
            expiresAt: Date.now() + VENDOR_CAPS_CACHE_TTL_MS
        }
        return value
    }

    /**
     * Persist one account's sprites.dev-reported capacity. Called by the
     * status-sync loop on every tick (3s on the fast cadence), so it no-ops
     * unless something moved or the last write is older than
     * VENDOR_CAPS_REFRESH_MS. Returns whether it wrote.
     */
    async recordSpritesVendorCapacity(
        accountId: string,
        observation: Omit<SpritesVendorAccountObservation, 'observedAt'>
    ): Promise<boolean> {
        const known = (await this.getCachedSpritesVendorCaps())[accountId]
        if (!shouldRecordObservation(known, observation, Date.now()))
            return false
        const entry: SpritesVendorAccountObservation = {
            ...observation,
            observedAt: new Date().toISOString()
        }
        // Two-level merge, NOT jsonbMerge: that helper is a shallow `||`, which
        // would replace the whole `accounts` object and drop every other
        // account's observation. Nested `||` also keeps concurrent writers (two
        // accounts in one tick, or two api instances) from clobbering.
        const patch = JSON.stringify({ [accountId]: entry })
        const merged = sql`
            coalesce(${appSettings.valueJson}, '{}'::jsonb) || jsonb_build_object(
                'accounts',
                coalesce(${appSettings.valueJson} -> 'accounts', '{}'::jsonb) || ${patch}::jsonb
            )`
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: SPRITES_VENDOR_CAPS_SETTING_KEY,
                    valueJson: { accounts: { [accountId]: entry } } as unknown as Record<
                        string,
                        unknown
                    >,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: { valueJson: merged, updatedAt: now }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            return false
        }
        this.vendorCapsCache = null
        return true
    }

    private async readSpritesVendorCaps(): Promise<
        Record<string, SpritesVendorAccountObservation>
    > {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, SPRITES_VENDOR_CAPS_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        const accounts = row?.valueJson?.accounts
        if (!accounts || typeof accounts !== 'object') return {}
        const out: Record<string, SpritesVendorAccountObservation> = {}
        for (const [accountId, value] of Object.entries(
            accounts as Record<string, unknown>
        )) {
            const parsed = parseVendorObservation(value)
            if (parsed) out[accountId] = parsed
        }
        return out
    }

    async getChatExecTimeouts(): Promise<ChatExecTimeoutsSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, CHAT_EXEC_TIMEOUTS_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readChatExecTimeouts(row?.valueJson)
    }

    async updateChatExecTimeouts(
        actorId: string,
        input: UpdateChatExecTimeoutsSettingsBody
    ): Promise<ChatExecTimeoutsSettings> {
        const normalized = this.normalizeChatExecTimeouts(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: CHAT_EXEC_TIMEOUTS_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.chatExecTimeoutsCache = null
        await this.audit(
            actorId,
            'admin.settings.chat_exec_timeouts.update',
            normalized as unknown as Record<string, unknown>,
            CHAT_EXEC_TIMEOUTS_SETTING_KEY
        )
        return normalized
    }

    async getAutomationRetention(): Promise<AutomationRetentionSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, AUTOMATION_RETENTION_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readAutomationRetention(row?.valueJson)
    }

    async updateAutomationRetention(
        actorId: string,
        input: UpdateAutomationRetentionSettingsBody
    ): Promise<AutomationRetentionSettings> {
        const normalized = this.normalizeAutomationRetention(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: AUTOMATION_RETENTION_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.automationRetentionCache = null
        await this.audit(
            actorId,
            'admin.settings.automation_retention_days.update',
            normalized as unknown as Record<string, unknown>,
            AUTOMATION_RETENTION_SETTING_KEY
        )
        return normalized
    }

    async getCachedAutomationRetention(): Promise<AutomationRetentionSettings> {
        if (
            this.automationRetentionCache &&
            this.automationRetentionCache.expiresAt > Date.now()
        )
            return this.automationRetentionCache.value
        const value = await this.getAutomationRetention()
        this.automationRetentionCache = {
            value,
            expiresAt: Date.now() + AUTOMATION_RETENTION_CACHE_TTL_MS
        }
        return value
    }

    async getCachedChatExecTimeouts(): Promise<ChatExecTimeoutsSettings> {
        if (
            this.chatExecTimeoutsCache &&
            this.chatExecTimeoutsCache.expiresAt > Date.now()
        )
            return this.chatExecTimeoutsCache.value
        const value = await this.getChatExecTimeouts()
        this.chatExecTimeoutsCache = {
            value,
            expiresAt: Date.now() + CHAT_EXEC_TIMEOUTS_CACHE_TTL_MS
        }
        return value
    }

    async getCachedChatExecTimeoutMs(): Promise<ResolvedChatExecTimeoutMs> {
        return resolveChatExecTimeoutMs(await this.getCachedChatExecTimeouts())
    }

    private async readA2aTurnTimeoutsRow(): Promise<Record<
        string,
        unknown
    > | null> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, A2A_TURN_TIMEOUTS_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return row?.valueJson ?? null
    }

    async getA2aTurnTimeouts(): Promise<A2aTurnTimeoutsSettings> {
        const value = await this.readA2aTurnTimeoutsRow()
        if (!value) return { ...DEFAULT_A2A_TURN_TIMEOUTS }
        return this.normalizeA2aTurnTimeouts({
            blockingTimeoutSeconds: Number(value.blockingTimeoutSeconds),
            asyncTimeoutSeconds: Number(value.asyncTimeoutSeconds)
        })
    }

    async updateA2aTurnTimeouts(
        actorId: string,
        input: UpdateA2aTurnTimeoutsSettingsBody
    ): Promise<A2aTurnTimeoutsSettings> {
        const normalized = this.normalizeA2aTurnTimeouts(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: A2A_TURN_TIMEOUTS_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.a2aTurnTimeoutsCache = null
        await this.audit(
            actorId,
            'admin.settings.a2a_turn_timeouts.update',
            normalized as unknown as Record<string, unknown>,
            A2A_TURN_TIMEOUTS_SETTING_KEY
        )
        return normalized
    }

    // Null when the admin never saved the setting — callers (A2aService) then
    // fall back to the legacy A2A_TURN_TIMEOUT_MS env var / code defaults.
    async getCachedA2aTurnTimeoutsOverride(): Promise<A2aTurnTimeoutsSettings | null> {
        if (
            this.a2aTurnTimeoutsCache &&
            this.a2aTurnTimeoutsCache.expiresAt > Date.now()
        )
            return this.a2aTurnTimeoutsCache.value
        const raw = await this.readA2aTurnTimeoutsRow()
        const value = raw
            ? this.normalizeA2aTurnTimeouts({
                  blockingTimeoutSeconds: Number(raw.blockingTimeoutSeconds),
                  asyncTimeoutSeconds: Number(raw.asyncTimeoutSeconds)
              })
            : null
        this.a2aTurnTimeoutsCache = {
            value,
            expiresAt: Date.now() + A2A_TURN_TIMEOUTS_CACHE_TTL_MS
        }
        return value
    }

    async getCliMinimumVersion(): Promise<CliMinimumVersionSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, CLI_MINIMUM_VERSION_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readCliMinimumVersion(row?.valueJson)
    }

    async updateCliMinimumVersion(
        actorId: string,
        input: UpdateCliMinimumVersionSettingsBody
    ): Promise<CliMinimumVersionSettings> {
        const normalized = this.normalizeCliMinimumVersion(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: CLI_MINIMUM_VERSION_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.cliMinimumVersionCache = null
        await this.audit(
            actorId,
            'admin.settings.cli_minimum_version.update',
            normalized as unknown as Record<string, unknown>,
            CLI_MINIMUM_VERSION_SETTING_KEY
        )
        return normalized
    }

    async getCachedCliMinimumVersion(): Promise<CliMinimumVersionSettings> {
        if (
            this.cliMinimumVersionCache &&
            this.cliMinimumVersionCache.expiresAt > Date.now()
        )
            return this.cliMinimumVersionCache.value
        const value = await this.getCliMinimumVersion()
        this.cliMinimumVersionCache = {
            value,
            expiresAt: Date.now() + CLI_MINIMUM_VERSION_CACHE_TTL_MS
        }
        return value
    }

    async getFrameworkRuntimeDefaults(): Promise<FrameworkRuntimeDefaultsSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(
                    eq(appSettings.key, FRAMEWORK_RUNTIME_DEFAULTS_SETTING_KEY)
                )
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readFrameworkRuntimeDefaults(row?.valueJson)
    }

    async updateFrameworkRuntimeDefaults(
        actorId: string,
        input: UpdateFrameworkRuntimeDefaultsSettingsBody
    ): Promise<FrameworkRuntimeDefaultsSettings> {
        const normalized = this.normalizeFrameworkRuntimeDefaults(input)
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: FRAMEWORK_RUNTIME_DEFAULTS_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.frameworkRuntimeDefaultsCache = null
        await this.audit(
            actorId,
            'admin.settings.framework_runtime_defaults.update',
            normalized as unknown as Record<string, unknown>,
            FRAMEWORK_RUNTIME_DEFAULTS_SETTING_KEY
        )
        return normalized
    }

    async getCachedFrameworkRuntimeDefaults(): Promise<FrameworkRuntimeDefaultsSettings> {
        if (
            this.frameworkRuntimeDefaultsCache &&
            this.frameworkRuntimeDefaultsCache.expiresAt > Date.now()
        )
            return this.frameworkRuntimeDefaultsCache.value
        const value = await this.getFrameworkRuntimeDefaults()
        this.frameworkRuntimeDefaultsCache = {
            value,
            expiresAt: Date.now() + FRAMEWORK_RUNTIME_DEFAULTS_CACHE_TTL_MS
        }
        return value
    }

    async getFrameworkDefaultVersions(): Promise<FrameworkDefaultVersionsSettings> {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(
                    eq(appSettings.key, FRAMEWORK_DEFAULT_VERSIONS_SETTING_KEY)
                )
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.readFrameworkDefaultVersions(row?.valueJson)
    }

    async updateFrameworkDefaultVersions(
        actorId: string,
        input: UpdateFrameworkDefaultVersionsSettingsBody
    ): Promise<FrameworkDefaultVersionsSettings> {
        // An omitted map means "unchanged", not "empty". For blockedVersions
        // the caller is the versions form, which does not edit it and would
        // otherwise un-block a broken release on the next save. For
        // sourceRepos and allowPrerelease it is also the rollout case: apps
        // deploy independently, so an older Admin build can PUT mid-rollout and
        // must not silently reset an operator's repository choice or close a
        // pre-release channel they are mid-verification on.
        const stored =
            input.blockedVersions === undefined ||
            input.sourceRepos === undefined ||
            input.allowPrerelease === undefined
                ? await this.getFrameworkDefaultVersions()
                : null
        const normalized = this.normalizeFrameworkDefaultVersions({
            ...input,
            blockedVersions:
                input.blockedVersions ?? stored?.blockedVersions ?? {},
            sourceRepos: input.sourceRepos ?? stored?.sourceRepos ?? {},
            allowPrerelease:
                input.allowPrerelease ?? stored?.allowPrerelease ?? {}
        })
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: FRAMEWORK_DEFAULT_VERSIONS_SETTING_KEY,
                    valueJson: normalized as unknown as Record<string, unknown>,
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: {
                        valueJson: normalized as unknown as Record<
                            string,
                            unknown
                        >,
                        updatedAt: now
                    }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.frameworkDefaultVersionsCache = null
        await this.audit(
            actorId,
            'admin.settings.framework_default_versions.update',
            normalized as unknown as Record<string, unknown>,
            FRAMEWORK_DEFAULT_VERSIONS_SETTING_KEY
        )
        return normalized
    }

    async getCachedFrameworkDefaultVersions(): Promise<FrameworkDefaultVersionsSettings> {
        if (
            this.frameworkDefaultVersionsCache &&
            this.frameworkDefaultVersionsCache.expiresAt > Date.now()
        )
            return this.frameworkDefaultVersionsCache.value
        const value = await this.getFrameworkDefaultVersions()
        this.frameworkDefaultVersionsCache = {
            value,
            expiresAt: Date.now() + FRAMEWORK_DEFAULT_VERSIONS_CACHE_TTL_MS
        }
        return value
    }

    async getFeatureToggles(): Promise<FeatureTogglesView> {
        const overrides = await this.readFeatureToggleOverrides()
        return { toggles: this.buildFeatureToggleViews(overrides) }
    }

    async updateFeatureToggle(
        actorId: string,
        key: string,
        enabled: boolean
    ): Promise<FeatureTogglesView> {
        if (!isFeatureToggleKey(key))
            throw new BadRequestException(`unknown feature toggle '${key}'`)
        const overrides = {
            ...(await this.readFeatureToggleOverrides()),
            [key]: Boolean(enabled)
        }
        const now = new Date()
        try {
            await this.db
                .insert(appSettings)
                .values({
                    key: FEATURE_TOGGLES_SETTING_KEY,
                    valueJson: { overrides },
                    updatedAt: now
                })
                .onConflictDoUpdate({
                    target: appSettings.key,
                    set: { valueJson: { overrides }, updatedAt: now }
                })
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
            throw new ServiceUnavailableException(
                'database migrations are required before admin settings can be updated'
            )
        }
        this.featureTogglesCache = null
        await this.audit(
            actorId,
            'admin.settings.feature_toggle.update',
            { key, enabled: Boolean(enabled) },
            FEATURE_TOGGLES_SETTING_KEY
        )
        return { toggles: this.buildFeatureToggleViews(overrides) }
    }

    async isFeatureEnabled(key: FeatureToggleKey): Promise<boolean> {
        const overrides = await this.getCachedFeatureToggleOverrides()
        const override = overrides[key]
        if (typeof override === 'boolean') return override
        const def = allFeatureToggles().find((toggle) => toggle.key === key)
        return def?.defaultEnabled ?? false
    }

    private async getCachedFeatureToggleOverrides(): Promise<
        Record<string, boolean>
    > {
        if (
            this.featureTogglesCache &&
            this.featureTogglesCache.expiresAt > Date.now()
        )
            return this.featureTogglesCache.value
        const value = await this.readFeatureToggleOverrides()
        this.featureTogglesCache = {
            value,
            expiresAt: Date.now() + FEATURE_TOGGLES_CACHE_TTL_MS
        }
        return value
    }

    private async readFeatureToggleOverrides(): Promise<
        Record<string, boolean>
    > {
        let row: { valueJson: Record<string, unknown> } | undefined
        try {
            ;[row] = await this.db
                .select({ valueJson: appSettings.valueJson })
                .from(appSettings)
                .where(eq(appSettings.key, FEATURE_TOGGLES_SETTING_KEY))
                .limit(1)
        } catch (err) {
            if (!isMissingRelationError(err)) throw err
        }
        return this.normalizeFeatureToggleOverrides(row?.valueJson)
    }

    private normalizeFeatureToggleOverrides(
        value: Record<string, unknown> | undefined
    ): Record<string, boolean> {
        const out: Record<string, boolean> = {}
        const raw =
            value && typeof value.overrides === 'object' && value.overrides
                ? (value.overrides as Record<string, unknown>)
                : null
        if (!raw) return out
        for (const [key, val] of Object.entries(raw))
            if (isFeatureToggleKey(key) && typeof val === 'boolean')
                out[key] = val
        return out
    }

    private buildFeatureToggleViews(
        overrides: Record<string, boolean>
    ): FeatureToggleView[] {
        return allFeatureToggles().map((def) => {
            const override = overrides[def.key]
            const overridden = typeof override === 'boolean'
            return {
                key: def.key,
                label: def.label,
                description: def.description,
                enabled: overridden ? override : def.defaultEnabled,
                defaultEnabled: def.defaultEnabled,
                overridden
            }
        })
    }

    private readFrameworkRuntimeDefaults(
        value: Record<string, unknown> | undefined
    ): FrameworkRuntimeDefaultsSettings {
        if (!value || typeof value !== 'object')
            throw new ServiceUnavailableException(
                'framework runtime defaults setting is missing; run database migrations'
            )
        const raw = value.defaults
        if (!raw || typeof raw !== 'object')
            throw new ServiceUnavailableException(
                'framework runtime defaults setting is malformed; run database migrations'
            )
        return this.normalizeFrameworkRuntimeDefaultsRaw(
            raw as Record<string, unknown>
        )
    }

    private normalizeFrameworkRuntimeDefaults(
        input: UpdateFrameworkRuntimeDefaultsSettingsBody
    ): FrameworkRuntimeDefaultsSettings {
        if (
            !input ||
            typeof input.defaults !== 'object' ||
            input.defaults === null
        )
            throw new BadRequestException('defaults must be an object')
        return this.normalizeFrameworkRuntimeDefaultsRaw(
            input.defaults as Record<string, unknown>
        )
    }

    private normalizeFrameworkRuntimeDefaultsRaw(
        raw: Record<string, unknown>
    ): FrameworkRuntimeDefaultsSettings {
        const normalized: Partial<
            FrameworkRuntimeDefaultsSettings['defaults']
        > = {}
        for (const [key, value] of Object.entries(raw)) {
            if (value === undefined || value === null)
                throw new BadRequestException(
                    `framework '${key}' default must be one of: sprites, k8s`
                )
            if (!ALL_AGENT_FRAMEWORKS.has(key as AgentFramework))
                throw new BadRequestException(
                    `unknown framework '${key}' in defaults`
                )
            if (
                !CONFIGURABLE_FRAMEWORK_RUNTIME_DEFAULTS.has(
                    key as AgentFramework
                )
            )
                throw new BadRequestException(
                    `framework '${key}' default is not configurable`
                )
            if (!FRAMEWORK_RUNTIME_CHOICES.has(value as FrameworkRuntimeChoice))
                throw new BadRequestException(
                    `framework '${key}' default must be one of: sprites, k8s`
                )
            normalized[
                key as keyof FrameworkRuntimeDefaultsSettings['defaults']
            ] = value as FrameworkRuntimeChoice
        }
        for (const key of configurableFrameworkRuntimeDefaults) {
            if (!normalized[key])
                throw new BadRequestException(
                    `framework '${key}' default is required`
                )
        }
        return {
            defaults: normalized as FrameworkRuntimeDefaultsSettings['defaults']
        }
    }

    private readFrameworkDefaultVersions(
        value: Record<string, unknown> | undefined
    ): FrameworkDefaultVersionsSettings {
        if (!value || typeof value !== 'object')
            return { ...DEFAULT_FRAMEWORK_DEFAULT_VERSIONS }
        return this.normalizeFrameworkDefaultVersionsRaw(value)
    }

    private normalizeFrameworkDefaultVersions(
        input: UpdateFrameworkDefaultVersionsSettingsBody
    ): FrameworkDefaultVersionsSettings {
        if (
            !input ||
            typeof input.defaults !== 'object' ||
            input.defaults === null
        )
            throw new BadRequestException('defaults must be an object')
        return this.normalizeFrameworkDefaultVersionsRaw(
            input as unknown as Record<string, unknown>
        )
    }

    private normalizeFrameworkDefaultVersionsRaw(
        raw: Record<string, unknown>
    ): FrameworkDefaultVersionsSettings {
        const defaults = this.normalizeFrameworkVersionMap(
            raw.defaults,
            'default version'
        )
        const minVersions = this.normalizeFrameworkVersionMap(
            raw.minVersions,
            'minimum version'
        )
        const allowDowngrade = this.normalizeFrameworkDowngradeMap(
            raw.allowDowngrade
        )
        const blockedVersions = this.normalizeFrameworkBlockedVersionsMap(
            raw.blockedVersions
        )
        const sourceRepos = this.normalizeFrameworkSourceRepoMap(
            raw.sourceRepos
        )
        const allowPrerelease = this.normalizeFrameworkPrereleaseMap(
            raw.allowPrerelease
        )
        // a pinned default install must sit at or above its minimum
        for (const [framework, version] of Object.entries(defaults)) {
            const min = minVersions[framework as AgentFramework]
            if (min && compareSemverPrecedence(version, min) === -1)
                throw new BadRequestException(
                    `framework '${framework}' default version ${version} is below its minimum supported version ${min}`
                )
        }
        // pinning a release the platform refuses to install would fail every
        // create against that framework; reject the pin instead
        for (const [framework, version] of Object.entries(defaults)) {
            const range = findBlockedVersionRange(
                version,
                blockedVersionRangesFor(framework as AgentFramework, {
                    blockedVersions
                })
            )
            if (range)
                throw new BadRequestException(
                    blockedVersionMessage(framework, version, range)
                )
        }
        // Same argument as the blocked check: the pin is the one route to an
        // install that never passes through the catalog, so a prerelease pinned
        // while the opt-in is off would be silently skipped at every create.
        // Refuse at config time, where an operator can see why.
        for (const [framework, version] of Object.entries(defaults)) {
            if (
                isPrereleaseVersion(version) &&
                !frameworkPrereleaseAllowed(framework as AgentFramework, {
                    allowPrerelease
                })
            )
                throw new BadRequestException(
                    `framework '${framework}' default version ${version} is a pre-release; enable pre-release versions for ${framework} first`
                )
        }
        return {
            defaults,
            minVersions,
            allowDowngrade,
            blockedVersions,
            sourceRepos,
            allowPrerelease
        }
    }

    // Which repository a git-installed framework's versions and clone come
    // from. The value is restricted to that framework's compiled-in candidates:
    // a sprite does not just fetch the repo, it builds and runs it, so a
    // free-text repository would be arbitrary code execution by settings edit.
    private normalizeFrameworkSourceRepoMap(
        raw: unknown
    ): Partial<Record<AgentFramework, string>> {
        const normalized: Partial<Record<AgentFramework, string>> = {}
        if (raw === undefined || raw === null) return normalized
        if (typeof raw !== 'object')
            throw new BadRequestException('sourceRepos map must be an object')
        for (const [key, value] of Object.entries(
            raw as Record<string, unknown>
        )) {
            // empty / null clears the override, restoring the default repo
            if (value === undefined || value === null || value === '') continue
            // covers unknown frameworks and npm-installed ones alike: neither
            // declares candidates, and neither has a repo to point anywhere
            const candidates = frameworkRepoCandidates(key)
            if (!candidates.length)
                throw new BadRequestException(
                    `framework '${key}' does not support a version source repository`
                )
            const repo = String(value).trim()
            if (!candidates.some((candidate) => candidate.repo === repo))
                throw new BadRequestException(
                    `framework '${key}' version source '${repo}' is not an allowed repository (allowed: ${candidates
                        .map((candidate) => candidate.repo)
                        .join(', ')})`
                )
            normalized[key as AgentFramework] = repo
        }
        return normalized
    }

    private normalizeFrameworkBlockedVersionsMap(
        raw: unknown
    ): Partial<Record<AgentFramework, FrameworkBlockedVersionRange[]>> {
        const normalized: Partial<
            Record<AgentFramework, FrameworkBlockedVersionRange[]>
        > = {}
        if (raw === undefined || raw === null) return normalized
        if (typeof raw !== 'object')
            throw new BadRequestException(
                'blockedVersions map must be an object'
            )
        for (const [key, value] of Object.entries(
            raw as Record<string, unknown>
        )) {
            if (value === undefined || value === null) continue
            if (!Array.isArray(value))
                throw new BadRequestException(
                    `framework '${key}' blockedVersions must be an array`
                )
            if (frameworkUpgradeMode(key) === null)
                throw new BadRequestException(
                    `framework '${key}' does not support a blocked version range`
                )
            const ranges: FrameworkBlockedVersionRange[] = []
            for (const entry of value) {
                const range = entry as Partial<FrameworkBlockedVersionRange>
                const min = String(range?.min ?? '').trim()
                const max = String(range?.max ?? '').trim()
                if (!parseCliSemver(min) || !parseCliSemver(max))
                    throw new BadRequestException(
                        `framework '${key}' blocked range bounds must be semver strings`
                    )
                if (compareCliSemver(min, max) === 1)
                    throw new BadRequestException(
                        `framework '${key}' blocked range ${min}-${max} is inverted`
                    )
                const reason = String(range?.reason ?? '').trim()
                if (!reason)
                    throw new BadRequestException(
                        `framework '${key}' blocked range ${min}-${max} needs a reason`
                    )
                ranges.push({ min, max, reason })
            }
            if (ranges.length) normalized[key as AgentFramework] = ranges
        }
        return normalized
    }

    private normalizeFrameworkVersionMap(
        raw: unknown,
        label: string
    ): Partial<Record<AgentFramework, string>> {
        const normalized: Partial<Record<AgentFramework, string>> = {}
        if (raw === undefined || raw === null) return normalized
        if (typeof raw !== 'object')
            throw new BadRequestException(`${label} map must be an object`)
        for (const [key, value] of Object.entries(
            raw as Record<string, unknown>
        )) {
            // empty / null clears the pin for that framework
            if (value === undefined || value === null || value === '') continue
            // only frameworks with an install/upgrade path are pinnable —
            // frameworkUpgradeMode is null for the external frameworks
            // (dify / langflow / a2a) which have no CLI to install.
            if (frameworkUpgradeMode(key) === null)
                throw new BadRequestException(
                    `framework '${key}' does not support a ${label}`
                )
            const version = String(value).trim()
            if (!parseCliSemver(version))
                throw new BadRequestException(
                    `framework '${key}' ${label} must be a semver string (optional leading v)`
                )
            normalized[key as AgentFramework] = version
        }
        return normalized
    }

    private normalizeFrameworkDowngradeMap(
        raw: unknown
    ): Partial<Record<AgentFramework, boolean>> {
        const normalized: Partial<Record<AgentFramework, boolean>> = {}
        if (raw === undefined || raw === null) return normalized
        if (typeof raw !== 'object')
            throw new BadRequestException('allowDowngrade map must be an object')
        for (const [key, value] of Object.entries(
            raw as Record<string, unknown>
        )) {
            if (value === undefined || value === null) continue
            if (typeof value !== 'boolean')
                throw new BadRequestException(
                    `framework '${key}' allowDowngrade must be a boolean`
                )
            if (frameworkUpgradeMode(key) === null)
                throw new BadRequestException(
                    `framework '${key}' does not support a downgrade policy`
                )
            // true is the default (allowed) — only persist the restrictive flag
            if (value === false) normalized[key as AgentFramework] = false
        }
        return normalized
    }

    // Mirror of normalizeFrameworkDowngradeMap with the default inverted: absent
    // means prereleases are withheld, which is how the catalog behaved before
    // the opt-in existed, so only the permissive flag is worth persisting.
    private normalizeFrameworkPrereleaseMap(
        raw: unknown
    ): Partial<Record<AgentFramework, boolean>> {
        const normalized: Partial<Record<AgentFramework, boolean>> = {}
        if (raw === undefined || raw === null) return normalized
        if (typeof raw !== 'object')
            throw new BadRequestException(
                'allowPrerelease map must be an object'
            )
        for (const [key, value] of Object.entries(
            raw as Record<string, unknown>
        )) {
            if (value === undefined || value === null) continue
            if (typeof value !== 'boolean')
                throw new BadRequestException(
                    `framework '${key}' allowPrerelease must be a boolean`
                )
            if (frameworkUpgradeMode(key) === null)
                throw new BadRequestException(
                    `framework '${key}' does not support pre-release versions`
                )
            if (value === true) normalized[key as AgentFramework] = true
        }
        return normalized
    }

    private readCliMinimumVersion(
        value: Record<string, unknown> | undefined
    ): CliMinimumVersionSettings {
        if (!value) return { ...DEFAULT_CLI_MINIMUM_VERSION }
        const raw = value.minVersion
        if (raw === null || raw === undefined || raw === '')
            return { minVersion: null }
        return this.normalizeCliMinimumVersion({ minVersion: String(raw) })
    }

    private normalizeCliMinimumVersion(
        input: UpdateCliMinimumVersionSettingsBody
    ): CliMinimumVersionSettings {
        const raw = input.minVersion
        if (raw === null || raw === undefined) return { minVersion: null }
        const trimmed = String(raw).trim()
        if (!trimmed) return { minVersion: null }
        if (!parseCliSemver(trimmed))
            throw new BadRequestException(
                'minVersion must be a semver string like 1.2.3 (optional leading v)'
            )
        return { minVersion: trimmed }
    }

    // Read is deliberately tolerant where the write path is strict: the purge
    // sweep calls this, and a corrupt stored value must degrade to the safe
    // 90-day default instead of wedging retention entirely.
    private readAutomationRetention(
        value: Record<string, unknown> | undefined
    ): AutomationRetentionSettings {
        const retentionDays = Number(value?.retentionDays)
        if (
            !Number.isInteger(retentionDays) ||
            retentionDays < 1 ||
            retentionDays > MAX_AUTOMATION_RETENTION_DAYS
        )
            return { ...DEFAULT_AUTOMATION_RETENTION }
        return { retentionDays }
    }

    private normalizeAutomationRetention(
        input: UpdateAutomationRetentionSettingsBody
    ): AutomationRetentionSettings {
        const retentionDays = Number(input.retentionDays)
        if (
            !Number.isInteger(retentionDays) ||
            retentionDays < 1 ||
            retentionDays > MAX_AUTOMATION_RETENTION_DAYS
        )
            throw new BadRequestException(
                `retentionDays must be an integer between 1 and ${MAX_AUTOMATION_RETENTION_DAYS}`
            )
        return { retentionDays }
    }

    private readChatExecTimeouts(
        value: Record<string, unknown> | undefined
    ): ChatExecTimeoutsSettings {
        if (!value) return { ...DEFAULT_CHAT_EXEC_TIMEOUTS }
        return this.normalizeChatExecTimeouts({
            keepAliveSeconds: Number(value.keepAliveSeconds),
            livenessTimeoutSeconds: Number(value.livenessTimeoutSeconds),
            maxTimeoutSeconds: Number(value.maxTimeoutSeconds)
        })
    }

    private normalizeChatExecTimeouts(
        input: UpdateChatExecTimeoutsSettingsBody
    ): ChatExecTimeoutsSettings {
        const keepAliveSeconds = Number(input.keepAliveSeconds)
        if (
            !Number.isInteger(keepAliveSeconds) ||
            keepAliveSeconds < 1 ||
            keepAliveSeconds > 600
        )
            throw new BadRequestException(
                'keepAliveSeconds must be an integer between 1 and 600'
            )
        const livenessTimeoutSeconds = Number(input.livenessTimeoutSeconds)
        if (
            !Number.isInteger(livenessTimeoutSeconds) ||
            livenessTimeoutSeconds <= keepAliveSeconds ||
            livenessTimeoutSeconds > 3600
        )
            throw new BadRequestException(
                'livenessTimeoutSeconds must be an integer greater than keepAliveSeconds and at most 3600'
            )
        const maxTimeoutSeconds = Number(input.maxTimeoutSeconds)
        if (
            !Number.isInteger(maxTimeoutSeconds) ||
            maxTimeoutSeconds < 0 ||
            maxTimeoutSeconds > MAX_CHAT_EXEC_TIMEOUT_SECONDS
        )
            throw new BadRequestException(
                `maxTimeoutSeconds must be an integer between 0 (unlimited) and ${MAX_CHAT_EXEC_TIMEOUT_SECONDS}`
            )
        return { keepAliveSeconds, livenessTimeoutSeconds, maxTimeoutSeconds }
    }

    private normalizeA2aTurnTimeouts(
        input: UpdateA2aTurnTimeoutsSettingsBody
    ): A2aTurnTimeoutsSettings {
        const blockingTimeoutSeconds = Number(input.blockingTimeoutSeconds)
        if (
            !Number.isInteger(blockingTimeoutSeconds) ||
            blockingTimeoutSeconds < MIN_A2A_TURN_TIMEOUT_SECONDS ||
            blockingTimeoutSeconds > MAX_A2A_BLOCKING_TIMEOUT_SECONDS
        )
            throw new BadRequestException(
                `blockingTimeoutSeconds must be an integer between ${MIN_A2A_TURN_TIMEOUT_SECONDS} and ${MAX_A2A_BLOCKING_TIMEOUT_SECONDS}`
            )
        const asyncTimeoutSeconds = Number(input.asyncTimeoutSeconds)
        if (
            !Number.isInteger(asyncTimeoutSeconds) ||
            asyncTimeoutSeconds < blockingTimeoutSeconds ||
            asyncTimeoutSeconds > MAX_A2A_ASYNC_TIMEOUT_SECONDS
        )
            throw new BadRequestException(
                `asyncTimeoutSeconds must be an integer between blockingTimeoutSeconds and ${MAX_A2A_ASYNC_TIMEOUT_SECONDS}`
            )
        return { blockingTimeoutSeconds, asyncTimeoutSeconds }
    }

    private readWholesaleCap(
        value: Record<string, unknown> | undefined
    ): SpritesWholesaleCapSettings {
        if (!value)
            return {
                activeCap: DEFAULT_SPRITES_WHOLESALE_ACTIVE_CAP,
                softThresholdPct: DEFAULT_SPRITES_WHOLESALE_SOFT_PCT
            }
        return this.normalizeWholesaleCap({
            activeCap: Number(value.activeCap),
            softThresholdPct: Number(value.softThresholdPct)
        })
    }

    private normalizeWholesaleCap(
        input: UpdateSpritesWholesaleCapSettingsBody
    ): SpritesWholesaleCapSettings {
        const activeCap = Number(input.activeCap)
        if (
            !Number.isFinite(activeCap) ||
            !Number.isInteger(activeCap) ||
            activeCap < 1
        )
            throw new BadRequestException(
                'activeCap must be a positive integer'
            )
        const softThresholdPct = Number(input.softThresholdPct)
        if (
            !Number.isFinite(softThresholdPct) ||
            !Number.isInteger(softThresholdPct) ||
            softThresholdPct < 1 ||
            softThresholdPct > 99
        )
            throw new BadRequestException(
                'softThresholdPct must be an integer between 1 and 99'
            )
        return { activeCap, softThresholdPct }
    }

    private readBuiltinSkillRepos(
        value: Record<string, unknown> | undefined
    ): BuiltinSkillRepoEntry[] {
        const raw = value && Array.isArray(value.repos) ? value.repos : null
        if (!raw)
            return DEFAULT_SKILL_REPOS.map((r) => ({
                owner: r.owner,
                name: r.name,
                branch: r.branch,
                enabled: true
            }))
        return this.normalizeBuiltinSkillRepos(raw)
    }

    private normalizeBuiltinSkillRepos(
        input: unknown[]
    ): BuiltinSkillRepoEntry[] {
        const seen = new Set<string>()
        const out: BuiltinSkillRepoEntry[] = []
        for (const item of input) {
            if (typeof item !== 'object' || item === null)
                throw new BadRequestException(
                    'builtin skill repo entries must be objects'
                )
            const record = item as Record<string, unknown>
            const owner = assertSafeGitHubOwner(String(record.owner ?? ''))
            const name = assertSafeGitHubRepo(String(record.name ?? ''))
            const branchRaw = String(record.branch ?? '').trim() || 'main'
            const branch = assertSafeGitRef(branchRaw)
            const enabled =
                record.enabled === undefined ? true : Boolean(record.enabled)
            const dedupeKey = `${owner}/${name}@${branch}`
            if (seen.has(dedupeKey))
                throw new BadRequestException(
                    `duplicate builtin skill repo: ${dedupeKey}`
                )
            seen.add(dedupeKey)
            out.push({ owner, name, branch, enabled })
        }
        return out
    }

    private async audit(
        actorId: string,
        action: string,
        meta: Record<string, unknown>,
        subject: string
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch {}
    }
}

export const isMissingRelationError = (err: unknown): boolean =>
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '42P01'
