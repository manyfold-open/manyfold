import { MF_ENV_API_URL } from './exec-env'

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

// The runner registers as a daemon host under a name derived from the sprite it
// lives on, so the API resolves "this sprite's runner" by (userId, kind=daemon,
// name) and a host on any other sprite can never be mistaken for it. This is the
// authoritative name the platform sets at register time (`daemon register
// --name`), so any consumer that must find or tear down a sprite's runner keys
// off this single source rather than the sprite-self-reported hostname.
export const runnerHostName = (spriteName: string): string =>
    `sprite-runner:${spriteName}`

// Reserved profile for the daemon that ships INSIDE a k8s agent image. A pod is
// the third managed-runner host: unlike a sprite the platform never installs or
// starts it (the image owns the binary and the entrypoint owns the process), so
// the API only ever looks the host up. It gets its own profile name so a pod and
// a sprite runner can never collide on the daemon state dir if an image is ever
// run somewhere unexpected.
export const POD_RUNNER_PROFILE = 'podrunner'

// A pod runner registers under a name derived from the RUNTIME it serves, not
// from an agent: the container provisioner creates the pod before any agent
// exists, and the agent orchestrator's pod is likewise addressed by its runtime
// row. Same contract as runnerHostName — this is the authoritative name the
// platform bakes into the pod's Secret and the only key lookup and teardown use.
export const podRunnerHostName = (runtimeId: string): string =>
    `pod-runner:${runtimeId}`

// The env a k8s agent image's entrypoint reads to enrol its daemon. These names
// are a cross-repo contract — the API writes them into the pod's Secret, the
// image's entrypoint reads them — so they live here beside the profile and host
// name rather than being re-typed on either side.
//
// MF_DAEMON_TOKEN is the one-time `ldt_` registration credential; the entrypoint
// consumes it into the daemon config on first boot and every later boot starts
// from that config instead. Absent, the entrypoint runs the framework alone and
// the pod behaves exactly as it did before pod runners existed.
export const MF_ENV_DAEMON_TOKEN = 'MF_DAEMON_TOKEN'
export const MF_ENV_DAEMON_HOST_NAME = 'MF_DAEMON_HOST_NAME'
export const MF_ENV_PROFILE = 'MF_PROFILE'
export const MF_ENV_CONFIG_DIR = 'MF_CONFIG_DIR'

export interface PodRunnerEnvInput {
    // Already `/api`-suffixed: the same base the agent's own MF_API_URL uses.
    apiBaseUrl: string
    daemonToken: string
    runtimeId: string
    // The image's manyfold home root, which for a coding agent image is exactly
    // the PVC mount path. Two things have to land inside it, and both are why
    // this is passed rather than defaulted:
    //   - the daemon's control plane (`profiles/podrunner/daemon/`), including
    //     the stable daemon uuid. Off the PVC the uuid is regenerated on every
    //     restart, and the token — bound to the first uuid it registered — is
    //     then refused for the new one.
    //   - the machine-scoped workspace root the registration DECLARES
    //     (`<root>/workspaces`, ADR-0014), which must be the parent of every
    //     agent workspace on this pod or the daemon's own containment check
    //     rejects the dir the API dispatches with.
    // `codingAgentWorkspacePath('k8s', id)` is `<K8S_HOME_BASE>/.manyfold/
    // workspaces/<id>`, so passing the coding pvcMountPath satisfies both.
    homeRoot: string
}

export const buildPodRunnerEnv = (
    input: PodRunnerEnvInput
): Record<string, string> => ({
    [MF_ENV_API_URL]: input.apiBaseUrl,
    [MF_ENV_DAEMON_TOKEN]: input.daemonToken,
    [MF_ENV_DAEMON_HOST_NAME]: podRunnerHostName(input.runtimeId),
    [MF_ENV_PROFILE]: POD_RUNNER_PROFILE,
    [MF_ENV_CONFIG_DIR]: input.homeRoot.replace(/\/+$/, '')
})

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
