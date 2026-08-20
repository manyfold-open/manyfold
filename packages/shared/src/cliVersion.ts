// Core-only version handling for the mf CLI: everything from the first `-` or
// `+` onwards is discarded, so `0.22.5-staging.<stamp>.<sha>` reads as `0.22.5`.
//
// That is load-bearing, not an oversight. Staging CLI builds carry a prerelease
// suffix (see isStagingCliVersion below) and are compared against a bare-semver
// floor by isCliVersionTooOld, which gates the sprite runner
// (runner-manager.service.ts) and the daemon upgrade banner
// (daemon-host.service.ts). Under semver precedence every staging build sits
// BELOW its own release, so making this family prerelease-aware would put the
// entire staging daemon fleet under every minimum version at once.
//
// Framework versions need the opposite semantics and get their own family in
// ./semver — see the note at the top of that file.
export const parseCliSemver = (
    input: string | null | undefined
): [number, number, number] | null => {
    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    if (!trimmed) return null
    const stripped = trimmed.replace(/^[vV]/, '')
    const core = stripped.split(/[-+]/, 1)[0]
    const parts = core.split('.')
    if (parts.length < 1 || parts.length > 3) return null
    const nums: number[] = []
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null
        nums.push(Number(part))
    }
    while (nums.length < 3) nums.push(0)
    return [nums[0], nums[1], nums[2]]
}

export const compareCliSemver = (
    a: string | null | undefined,
    b: string | null | undefined
): -1 | 0 | 1 | null => {
    const parsedA = parseCliSemver(a)
    const parsedB = parseCliSemver(b)
    if (!parsedA || !parsedB) return null
    for (let i = 0; i < 3; i += 1) {
        if (parsedA[i] < parsedB[i]) return -1
        if (parsedA[i] > parsedB[i]) return 1
    }
    return 0
}

export const isCliVersionTooOld = (
    cliVersion: string | null | undefined,
    minVersion: string | null | undefined
): boolean => {
    if (!minVersion) return false
    if (!parseCliSemver(minVersion)) return false
    if (!cliVersion) return true
    const cmp = compareCliSemver(cliVersion, minVersion)
    if (cmp === null) return true
    return cmp < 0
}

export type MfCliChannel = 'stable' | 'staging'

export const isCliUpdateAvailable = (
    channel: MfCliChannel,
    current: string | null | undefined,
    latest: string | null | undefined
): boolean => {
    if (!latest) return false
    if (!current) return true
    if (channel === 'staging') return current !== latest
    return compareCliSemver(current, latest) === -1
}

// Staging CLI builds are versioned `x.y.z-staging.<stamp>.<sha>` (see the
// release-cli-staging workflow); stable builds are bare semver. The prerelease
// marker is the channel discriminator for a given version string.
export const isStagingCliVersion = (
    version: string | null | undefined
): boolean => typeof version === 'string' && version.includes('-staging.')

export const cliChannelOfVersion = (
    version: string | null | undefined
): MfCliChannel => (isStagingCliVersion(version) ? 'staging' : 'stable')
