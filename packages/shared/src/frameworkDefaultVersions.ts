import type { AgentFramework } from './constants'
import type { FrameworkBlockedVersionRange } from './framework-versions'

/**
 * Per-framework version policy, applied by the provisioner at bootstrap and by
 * the framework-version upgrade flow. Covers every framework whose
 * `frameworkUpgradeMode` is non-null (the sprite frameworks with an
 * install/upgrade path, incl. hermes via its CalVer tags); external-API
 * runtimes with no installable CLI stay excluded.
 *
 * - `defaults`: the version a new sprite agent installs. A missing entry keeps
 *   the framework's built-in default (image binary / latest / hardcoded clone).
 * - `minVersions`: the lowest version the upgrade API will install for that
 *   framework. A pinned default must be >= its min. Floor applies to everyone.
 * - `allowDowngrade`: per-framework downgrade gate. A missing entry means
 *   downgrade is allowed (today's behaviour); only `false` restricts it, and
 *   admins are exempt from the restriction.
 * - `blockedVersions`: operator-added broken-release windows, unioned with the
 *   built-in list below. Lets an incident be contained without a deploy.
 * - `sourceRepos`: which repository a git-installed framework comes from,
 *   chosen from that framework's code-defined candidates. Drives BOTH the
 *   version catalog and the install/upgrade clone.
 * - `allowPrerelease`: opt-in to semver prerelease versions (`1.15.1-rc.1`,
 *   `-test.2`, `-dev`) for that framework. Missing means off, which is the
 *   historical behaviour: the catalog dropped every hyphenated version. Even
 *   when on, `latest` stays the newest STABLE release — the implicit tier every
 *   fresh agent installs must not drift onto a release candidate — so reaching
 *   a prerelease is always a deliberate act (an admin pin, or picking it).
 */
export interface FrameworkDefaultVersionsSettings {
    defaults: Partial<Record<AgentFramework, string>>
    minVersions: Partial<Record<AgentFramework, string>>
    allowDowngrade: Partial<Record<AgentFramework, boolean>>
    blockedVersions: Partial<
        Record<AgentFramework, FrameworkBlockedVersionRange[]>
    >
    sourceRepos: Partial<Record<AgentFramework, string>>
    allowPrerelease: Partial<Record<AgentFramework, boolean>>
}

export interface UpdateFrameworkDefaultVersionsSettingsBody {
    defaults: Partial<Record<AgentFramework, string>>
    minVersions?: Partial<Record<AgentFramework, string>>
    allowDowngrade?: Partial<Record<AgentFramework, boolean>>
    // omitted (not `{}`) keeps whatever is stored — the admin versions form
    // does not edit this map and must not wipe it on save
    blockedVersions?: Partial<
        Record<AgentFramework, FrameworkBlockedVersionRange[]>
    >
    // omitted keeps whatever is stored, for the same reason as blockedVersions
    // and one more: independent app deploys mean an older Admin build can PUT
    // during a rollout, and resetting an operator's repository choice back to
    // the default mid-incident would be silent and hard to attribute
    sourceRepos?: Partial<Record<AgentFramework, string>>
    // omitted keeps whatever is stored, same rollout argument as sourceRepos:
    // an Admin build predating this field would otherwise close a prerelease
    // channel an operator is mid-verification on
    allowPrerelease?: Partial<Record<AgentFramework, boolean>>
}

export const DEFAULT_FRAMEWORK_DEFAULT_VERSIONS: FrameworkDefaultVersionsSettings =
    {
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {},
        sourceRepos: {},
        allowPrerelease: {}
    }

/**
 * Releases the platform refuses to install, shipped in code so protection does
 * not depend on an operator having configured anything, and cannot be lost with
 * the settings row.
 *
 * Lifting an entry is deliberately a code change: #594's acceptance criteria
 * require verifying the replacement npm bundle actually carries the upstream fix
 * before auto-latest may reach that range again.
 */
export const BUILTIN_BLOCKED_FRAMEWORK_VERSIONS: Partial<
    Record<AgentFramework, FrameworkBlockedVersionRange[]>
> = {
    'gemini-cli': [
        {
            min: '0.53.0',
            max: '0.54.0',
            reason: 'gemini-cli 0.53.0-0.54.0 drops the thought signature from completed tool-call history (google-gemini/gemini-cli#28604), so every later turn of a tool-using session fails with a provider 400. Use 0.52.0 or a release carrying the #28607 fix.'
        }
    ]
}

// Built-in windows plus whatever an operator added. Both are advisory-free: any
// hit is a hard refusal at every admission point (fresh install, explicit
// create, admin pin, in-place upgrade, catalog listing).
export const blockedVersionRangesFor = (
    framework: AgentFramework,
    settings?: Pick<FrameworkDefaultVersionsSettings, 'blockedVersions'> | null
): FrameworkBlockedVersionRange[] => [
    ...(BUILTIN_BLOCKED_FRAMEWORK_VERSIONS[framework] ?? []),
    ...(settings?.blockedVersions?.[framework] ?? [])
]

// One read point for the prerelease opt-in. Unreadable settings mean off, which
// is the pre-feature behaviour — a control plane that cannot answer must not
// widen what gets installed.
export const frameworkPrereleaseAllowed = (
    framework: AgentFramework,
    settings?: Pick<FrameworkDefaultVersionsSettings, 'allowPrerelease'> | null
): boolean => settings?.allowPrerelease?.[framework] === true
