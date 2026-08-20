import { compareCliSemver, parseCliSemver } from './cliVersion'
import { compareSemverPrecedence, isPrereleaseVersion } from './semver'

// Frameworks whose agent CLI carries an installable, upgradeable version on a
// sprite. dify / langflow / a2a are external-API runtimes with no CLI, so they
// are intentionally excluded.
export const versionedFrameworks = [
    'claude-code',
    'codex',
    'gemini-cli',
    'openclaw',
    'hermes',
    'narranexus'
] as const
export type VersionedFramework = (typeof versionedFrameworks)[number]

export const isVersionedFramework = (
    value: unknown
): value is VersionedFramework =>
    typeof value === 'string' &&
    versionedFrameworks.includes(value as VersionedFramework)

export type FrameworkUpgradeMode = 'npm' | 'rebuild'

// How each framework's in-place upgrade is driven (null = not upgradeable yet):
//  - 'npm'     fast `npm i -g` + ~/.local/bin symlink (synchronous endpoint)
//  - 'rebuild' heavy git re-clone + build, streamed (narranexus, hermes)
// hermes re-runs NousResearch's install.sh pinned to a CalVer tag
// (`--branch v2026.x.y`); the catalog tag is the version of record, not the
// decoupled pyproject version `hermes --version` prints.
export const frameworkUpgradeMode = (
    framework: unknown
): FrameworkUpgradeMode | null => {
    switch (framework) {
        case 'claude-code':
        case 'codex':
        case 'gemini-cli':
        case 'openclaw':
            return 'npm'
        case 'narranexus':
        case 'hermes':
            return 'rebuild'
        default:
            return null
    }
}

export const isUpgradeableFramework = (framework: unknown): boolean =>
    frameworkUpgradeMode(framework) !== null

export type FrameworkVersionSourceKind = 'npm' | 'github'

export interface FrameworkVersionCatalogEntry {
    framework: VersionedFramework
    // newest version the platform knows about; null until first successful fetch
    latest: string | null
    // every version offered by the upstream source, newest-first
    versions: string[]
    source: FrameworkVersionSourceKind
    // For a github source, the `owner/name` these versions are fetched from and
    // installed from — one value, so a client can never show one repository's
    // tags while the install clones another. null for an npm source.
    sourceRepo: string | null
    // ISO timestamp of the last successful upstream fetch; null = never fetched
    fetchedAt: string | null
    // ranges withheld from `versions`/`latest` (see FrameworkBlockedVersionRange).
    // Carried so a client can explain WHY a release is missing from the picker.
    blocked: FrameworkBlockedVersionRange[]
}

/**
 * A closed interval of releases the platform refuses to install, inclusive on
 * both ends.
 *
 * A broken upstream release is not a "minimum version" problem: the bad window
 * is bounded on both sides (0.53.0–0.54.0 is broken while 0.52.0 and a future
 * 0.55.0 are fine), so raising a floor would also bar every good release below
 * it. See #594 — gemini-cli 0.53.0 dropped the thought signature from completed
 * tool-call history, which makes every later turn of that session 400.
 */
export interface FrameworkBlockedVersionRange {
    // inclusive lower bound
    min: string
    // inclusive upper bound
    max: string
    // shown to whoever hits the rejection, so it must say what breaks and why
    reason: string
}

export const findBlockedVersionRange = (
    version: string | null | undefined,
    ranges: readonly FrameworkBlockedVersionRange[] | undefined
): FrameworkBlockedVersionRange | null => {
    if (!version || !ranges?.length) return null
    for (const range of ranges) {
        // Core-only comparison ON PURPOSE, unlike every other gate in this
        // file: a prerelease of a blocked release must stay blocked, so
        // `0.53.0-rc.1` has to fall inside `[0.53.0, 0.54.0]`. Semver
        // precedence would put it below the lower bound and let it through —
        // correct by the spec, wrong for a broken-release window, where the
        // failure mode is shipping the bug rather than withholding a build.
        const low = compareCliSemver(version, range.min)
        const high = compareCliSemver(version, range.max)
        // an unparseable version can't be proven safe OR unsafe; treat it as
        // out of range rather than blocking something we cannot compare
        if (low === null || high === null) continue
        if (low >= 0 && high <= 0) return range
    }
    return null
}

export const blockedVersionMessage = (
    framework: string,
    version: string,
    range: FrameworkBlockedVersionRange
): string =>
    `${framework} ${version} is blocked (${range.min}–${range.max}): ${range.reason}`

/**
 * npm dist-tag spec that can never resolve into a blocked range, for the one
 * install path that has no exact target to pin (catalog unreachable AND the
 * sprite image ships no binary — see installFrameworkVersion).
 *
 * The complement of a union of closed intervals is itself a union of open ones,
 * which node-semver expresses directly: sorted, merged ranges [a1,b1]…[an,bn]
 * become `<a1 || >b1 <a2 || … || >bn`. Resolution stays registry-side, so npm
 * still picks the newest release — just never one inside a bad window.
 */
export const safeNpmVersionSpec = (
    ranges: readonly FrameworkBlockedVersionRange[] | undefined
): string => {
    const sorted = [...(ranges ?? [])]
        .filter(
            (r) =>
                parseCliSemver(r.min) !== null && parseCliSemver(r.max) !== null
        )
        .sort((a, b) => compareCliSemver(a.min, b.min) ?? 0)
    if (!sorted.length) return 'latest'
    const merged: FrameworkBlockedVersionRange[] = []
    for (const range of sorted) {
        const last = merged[merged.length - 1]
        if (last && (compareCliSemver(range.min, last.max) ?? 1) <= 0) {
            if ((compareCliSemver(range.max, last.max) ?? 0) > 0)
                merged[merged.length - 1] = { ...last, max: range.max }
            continue
        }
        merged.push(range)
    }
    const clauses = [`<${merged[0].min}`]
    for (let i = 0; i < merged.length; i++) {
        const next = merged[i + 1]
        clauses.push(
            next ? `>${merged[i].max} <${next.min}` : `>${merged[i].max}`
        )
    }
    return clauses.join(' || ')
}

// `latest` is a strict upgrade over what's installed. Returns false when either
// side is unparseable (e.g. hermes 'main') so the UI never nags on fuzzy
// versions. Precedence-aware, so an agent sitting on `1.15.1-rc.1` is correctly
// offered the `1.15.1` release.
export const frameworkUpgradeAvailable = (
    installed: string | null | undefined,
    latest: string | null | undefined
): boolean => {
    if (!installed || !latest) return false
    return compareSemverPrecedence(installed, latest) === -1
}

// Two parsers for `<bin> --version` output, and the choice between them is a
// rule, not a preference:
//
//   PERSISTED anywhere        -> parseProbedSemver (keep the whole string)
//   compared and thrown away  -> parseProbedVersion (core is enough)
//
// A truncated version that reaches a column outlives the comparison it was
// truncated for, and every later reader inherits a value that exists in no
// registry or repository. #777 was exactly that: the mf CLI probe stored
// `0.22.5` for a `0.22.5-staging.<stamp>.<sha>` build, and the staging update
// check compares by string equality (build stamps are not semver-comparable), so
// a sandbox on the exact latest build was told to update forever.
//
// Extract the first semver-looking token, truncating any prerelease/build suffix
// (e.g. "2.1.92 (Claude Code)" -> "2.1.92"). Returns null if none found. Only
// for a value that is compared and discarded — today just the claude-code
// adapter's xhigh gate, which compares with the core-only family in cliVersion.
export const parseProbedVersion = (output: string): string | null => {
    const match = /(\d+\.\d+\.\d+)/.exec(output)
    return match ? match[1] : null
}

// parseProbedVersion, but keeping any prerelease/build suffix. Use this for
// every value that gets stored: runtime_hosts.cli_version and
// agent_runtimes.framework_version each have several writers, and they have to
// agree on the format or the precedence comparisons downstream disagree about
// the same installed build.
export const parseProbedSemver = (output: string): string | null => {
    const match =
        /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(
            output
        )
    return match ? match[0] : null
}

// Where a bootstrap's install target came from. Drives the failure policy: an
// asked-for version (user dto / admin pin) failing to install is a hard error,
// while the implicit "just give me latest" default degrades to whatever the
// sprite image already ships — creating an agent must not depend on the npm
// registry being reachable.
// Named "install source" to avoid colliding with the api-side
// FrameworkVersionSource (npm vs github upstream) in framework-version-registry.
export type FrameworkInstallSource = 'explicit' | 'admin' | 'latest' | 'none'

export type FrameworkVersionSelection =
    | {
          version: string
          source: Exclude<FrameworkInstallSource, 'none'>
          // set only for an explicit request: the caller named a version inside
          // a blocked range and must be told, not silently given something else
          blockedBy?: FrameworkBlockedVersionRange
          // set only for an explicit request: the caller named a prerelease
          // while the framework's opt-in is off, same reasoning as blockedBy
          prereleaseNotAllowed?: true
      }
    | { version: null; source: 'none' }

// Resolve the version a fresh agent installs. `latest` is the default so new
// agents track upstream instead of freezing on the sprite image's baked-in
// binary; a caller that can't resolve a catalog latest still gets `none`, which
// keeps each framework's built-in fallback (image binary / dist-tag / hardcoded
// clone tag).
//
// `blocked` is the admission gate (#594). A blocked admin pin or catalog latest
// is skipped so provisioning degrades to the next tier instead of installing a
// known-broken CLI; a blocked explicit request is returned with `blockedBy` set
// so the caller can reject it with a reason rather than quietly substituting.
//
// `allowPrerelease` is the second admission gate and works the same way. It is
// needed here even though the catalog already withholds prereleases when the
// opt-in is off: an explicit request and an admin pin never pass through the
// catalog, so filtering there alone would leave both routes open.
export const selectFrameworkInstallVersion = (input: {
    requested?: string | null
    adminDefault?: string | null
    catalogLatest?: string | null
    blocked?: readonly FrameworkBlockedVersionRange[]
    allowPrerelease?: boolean
}): FrameworkVersionSelection => {
    const prereleaseRefused = (version: string): boolean =>
        !input.allowPrerelease && isPrereleaseVersion(version)
    const requested = input.requested?.trim()
    if (requested) {
        const blockedBy = findBlockedVersionRange(requested, input.blocked)
        if (blockedBy)
            return { version: requested, source: 'explicit', blockedBy }
        return prereleaseRefused(requested)
            ? {
                  version: requested,
                  source: 'explicit',
                  prereleaseNotAllowed: true
              }
            : { version: requested, source: 'explicit' }
    }
    const adminDefault = input.adminDefault?.trim()
    if (
        adminDefault &&
        !findBlockedVersionRange(adminDefault, input.blocked) &&
        !prereleaseRefused(adminDefault)
    )
        return { version: adminDefault, source: 'admin' }
    const catalogLatest = input.catalogLatest?.trim()
    // The catalog's `latest` is stable by construction, so this tier cannot
    // introduce a prerelease; the guard is here for a stored value written
    // before that invariant existed.
    if (
        catalogLatest &&
        !findBlockedVersionRange(catalogLatest, input.blocked) &&
        !prereleaseRefused(catalogLatest)
    )
        return { version: catalogLatest, source: 'latest' }
    return { version: null, source: 'none' }
}

// Whether an install is needed to reach `target`. Only an exact match skips —
// a deliberate downgrade (admin pinning below what's installed) must still run.
// An unknown or unparseable installed version installs, so a fuzzy probe never
// silently leaves the image binary in place.
//
// Precedence-aware: under core-only comparison `1.15.1` and `1.15.1-rc.1` read
// as equal, so targeting the rc from the release would skip the install and
// leave the wrong build on the sprite while reporting success.
export const shouldInstallFrameworkVersion = (
    installed: string | null | undefined,
    target: string
): boolean => {
    if (!installed) return true
    return compareSemverPrecedence(installed, target) !== 0
}
