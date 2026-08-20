// ADR-0014: a profile is the local projection of one environment, and it
// projects the CONTROL PLANE only (credentials, pending login, daemon state)
// under `<configRoot>/profiles/<name>/`. The data plane — workspaces and the
// host skill store — is machine-scoped, shared by every profile and addressed
// by globally-unique agent id; hosts that want isolation declare custom roots
// at registration instead. This module is the single source of truth for that
// layout: the CLI derives local paths from it and the API derives remote
// probe/exec paths from it, so the two sides cannot drift.
//
// Paths are composed with '/' deliberately — remote hosts (sprites, daemon
// machines) are POSIX, and Node fs APIs accept '/' on Windows.

// The name feeds config paths, the daemon state dir, init unit names and the
// control socket, so it is strictly validated (no dots, slashes or spaces).
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export const isValidProfileName = (name: string): boolean =>
    PROFILE_NAME_RE.test(name)

// Reserved profile for the resident runner daemon inside a sprite; the API
// probes and registers it by this exact name.
export const RUNNER_PROFILE = 'spriterunner'

export interface ProfilePaths {
    dir: string
    configPath: string
    pendingLoginPath: string
    daemonDir: string
    daemonConfigPath: string
}

export const profilesRoot = (configRoot: string): string =>
    `${configRoot}/profiles`

export const profilePaths = (
    configRoot: string,
    profile: string
): ProfilePaths => {
    const dir = `${profilesRoot(configRoot)}/${profile}`
    return {
        dir,
        configPath: `${dir}/config.json`,
        pendingLoginPath: `${dir}/pending-login.json`,
        daemonDir: `${dir}/daemon`,
        daemonConfigPath: `${dir}/daemon/config.json`
    }
}

// Machine-scoped data plane, shared by every profile: registration defaults
// for workspaceBaseDir/skillsDir on every host kind.
export const machineWorkspacesRoot = (configRoot: string): string =>
    `${configRoot}/workspaces`

export const machineSkillsDir = (configRoot: string): string =>
    `${configRoot}/skills`
