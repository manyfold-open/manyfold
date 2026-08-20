// Full semver 2.0.0 — prerelease identifiers included — for the framework
// version catalog, its pickers and its install/upgrade paths.
//
// Deliberately separate from the core-only family in ./cliVersion, which the mf
// CLI depends on ignoring prerelease suffixes (see the note there). Two
// comparison semantics coexist on purpose; pick by domain, not by taste:
//   - framework versions (this file): `1.15.1-rc.1` sorts BELOW `1.15.1`
//   - mf CLI versions (./cliVersion): `0.22.5-staging.<stamp>` EQUALS `0.22.5`

export interface Semver {
    major: number
    minor: number
    patch: number
    // dot-separated prerelease identifiers; empty for a stable release
    prerelease: string[]
    // ignored by precedence (§10), kept so a caller can echo the exact input
    build: string | null
}

// Leading zeros are tolerated in numeric positions where the spec forbids them.
// Being stricter than the guard this replaces (`/^v?\d+\.\d+\.\d+$/`) would
// newly reject a tag that installs today, and the point of the pattern is to
// keep shell metacharacters out — not to police an upstream's tag hygiene.
const IDENTIFIERS = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*'
/**
 * The shape isSemverVersionTag accepts, exported for declarative validators
 * (class-validator's `@Matches`) that cannot call a function. Use
 * isSemverVersionTag anywhere a value is about to reach a shell — it adds the
 * charset assertion below, and it is the guard of record.
 */
export const SEMVER_TAG_RE = new RegExp(
    `^[vV]?\\d+\\.\\d+\\.\\d+(?:-${IDENTIFIERS})?(?:\\+${IDENTIFIERS})?$`
)
// Every character a valid semver string can contain. Asserted separately from
// SEMVER_TAG_RE so a later edit to the pattern cannot quietly widen what reaches
// a shell: both clone builders interpolate a version into
// `git clone --branch "<tag>"`, and `npm install` takes one too.
const SAFE_CHARS_RE = /^[0-9A-Za-z.+-]+$/

/**
 * Whether a string is safe to use as an installable version/tag.
 *
 * Requires all three core components, matching the guard it replaces. A tag
 * that passes carries no whitespace, quote, `;`, `$`, backtick, `&`, `|`,
 * parenthesis, redirection or newline, so it cannot break out of the
 * double-quoted shell word it is interpolated into.
 */
export const isSemverVersionTag = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    const trimmed = value.trim()
    return SAFE_CHARS_RE.test(trimmed) && SEMVER_TAG_RE.test(trimmed)
}

/**
 * Parse for comparison. Accepts one to three core components (padded with
 * zeros) so it stays at least as permissive as parseCliSemver — a version that
 * used to compare must not become incomparable. Use isSemverVersionTag, not
 * this, to decide whether something may be installed.
 */
export const parseSemver = (
    input: string | null | undefined
): Semver | null => {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    if (!trimmed || !SAFE_CHARS_RE.test(trimmed)) return null
    const stripped = trimmed.replace(/^[vV]/, '')
    const plus = stripped.indexOf('+')
    const build = plus === -1 ? null : stripped.slice(plus + 1)
    const withoutBuild = plus === -1 ? stripped : stripped.slice(0, plus)
    if (build !== null && !new RegExp(`^${IDENTIFIERS}$`).test(build))
        return null
    const dash = withoutBuild.indexOf('-')
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)
    const pre = dash === -1 ? null : withoutBuild.slice(dash + 1)
    if (pre !== null && !new RegExp(`^${IDENTIFIERS}$`).test(pre)) return null
    const parts = core.split('.')
    if (parts.length < 1 || parts.length > 3) return null
    const nums: number[] = []
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null
        nums.push(Number(part))
    }
    while (nums.length < 3) nums.push(0)
    return {
        major: nums[0],
        minor: nums[1],
        patch: nums[2],
        prerelease: pre === null ? [] : pre.split('.'),
        build
    }
}

export const isPrereleaseVersion = (
    value: string | null | undefined
): boolean => (parseSemver(value)?.prerelease.length ?? 0) > 0

/**
 * Semver 2.0.0 §11 precedence. Returns null when either side is unparseable,
 * matching compareCliSemver so callers keep one "cannot compare" branch.
 */
export const compareSemverPrecedence = (
    a: string | null | undefined,
    b: string | null | undefined
): -1 | 0 | 1 | null => {
    const parsedA = parseSemver(a)
    const parsedB = parseSemver(b)
    if (!parsedA || !parsedB) return null
    const core = compareNumbers(
        [parsedA.major, parsedA.minor, parsedA.patch],
        [parsedB.major, parsedB.minor, parsedB.patch]
    )
    if (core !== 0) return core
    // §11.3: equal cores, but a version carrying a prerelease has LOWER
    // precedence than the release it precedes.
    const preA = parsedA.prerelease
    const preB = parsedB.prerelease
    if (!preA.length && !preB.length) return 0
    if (!preA.length) return 1
    if (!preB.length) return -1
    return comparePrereleaseIdentifiers(preA, preB)
}

const compareNumbers = (a: number[], b: number[]): -1 | 0 | 1 => {
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] < b[i]) return -1
        if (a[i] > b[i]) return 1
    }
    return 0
}

// §11.4: identifier by identifier — numeric compared numerically, numeric
// always below alphanumeric, alphanumeric compared by ASCII order; when all
// leading identifiers are equal the longer set wins (`alpha` < `alpha.1`).
const comparePrereleaseIdentifiers = (a: string[], b: string[]): -1 | 0 | 1 => {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if (i >= a.length) return -1
        if (i >= b.length) return 1
        const left = a[i]
        const right = b[i]
        if (left === right) continue
        const leftNumeric = /^\d+$/.test(left)
        const rightNumeric = /^\d+$/.test(right)
        if (leftNumeric && rightNumeric)
            return Number(left) < Number(right) ? -1 : 1
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
        return left < right ? -1 : 1
    }
    return 0
}
