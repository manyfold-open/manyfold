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

// Reserved profile for the host daemon the platform runs inside a sprite; the
// API probes and starts it by this exact name.
export const RUNNER_PROFILE = 'spriterunner'

// Reserved profile for the daemon a Kubernetes pod host runs (ADR-0035): the
// image's boot loop registers and starts it, so the API installs nothing to
// bring it up. It gets its own profile name so a pod and a sprite daemon can
// never collide on the daemon state dir if the image is ever run somewhere
// unexpected.
export const POD_RUNNER_PROFILE = 'podrunner'

// The env a pod host image's boot loop reads to enrol its daemon. These names
// are a cross-repo contract — the API writes them into the pod's Secret, the
// image's boot script reads them — so they live here beside the profile name
// rather than being re-typed on either side.
//
// MF_DAEMON_TOKEN is the one-time `ldt_` registration credential, bound to the
// pod host it registers onto (ADR-0037); the boot loop consumes it into the
// daemon config on first boot and every later boot starts from that config
// instead, so a later boot does not need it: the registration already lives on
// the PVC.
const MF_ENV_DAEMON_TOKEN = 'MF_DAEMON_TOKEN'
const MF_ENV_PROFILE = 'MF_PROFILE'
const MF_ENV_CONFIG_DIR = 'MF_CONFIG_DIR'

interface PodRunnerEnvInput {
    // Already `/api`-suffixed: the same base the agent's own MF_API_URL uses.
    apiBaseUrl: string
    daemonToken: string
    // The daemon's manyfold home root on the pod's PVC. Two things have to land
    // inside it, and both are why this is passed rather than defaulted:
    //   - the daemon's control plane (`profiles/podrunner/daemon/`), including
    //     the stable daemon uuid. Off the PVC the uuid is regenerated on every
    //     restart, and the token — bound to the first uuid it registered — is
    //     then refused for the new one.
    //   - the machine-scoped workspace root the registration DECLARES
    //     (`<root>/workspaces`, ADR-0014), which must be the parent of every
    //     agent workspace on this pod or the daemon's own containment check
    //     rejects the dir the API dispatches with.
    // `codingAgentWorkspacePath('k8s', id)` is `<K8S_HOME_BASE>/.manyfold/
    // workspaces/<id>`, and the PVC is the whole home, so `~/.manyfold`
    // satisfies both.
    homeRoot: string
}

export const buildPodRunnerEnv = (
    input: PodRunnerEnvInput
): Record<string, string> => ({
    [MF_ENV_API_URL]: input.apiBaseUrl,
    [MF_ENV_DAEMON_TOKEN]: input.daemonToken,
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

// Host-local auth store (runtime auth profiles): machine-scoped like the
// workspaces root, namespaced below by the host id the daemon registered onto
// so two control planes on one machine never read each other's credentials.
export const runtimeAuthRoot = (configRoot: string): string =>
    `${configRoot}/runtime-auth`

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// A URL hostname (IPv6 keeps its brackets) that only reaches this machine.
export const isLoopbackHostname = (hostname: string): boolean => {
    const host = hostname.toLowerCase()
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')
}

// Names an agent setup guide must never pick for a deployment of its own: the
// profiles a binary selects by itself, the legacy dev-channel name, the
// profile the plugin README uses for the hosted API, and the runner profiles.
const RESERVED_DEPLOYMENT_PROFILES = new Set([
    'default',
    'dev',
    'staging',
    'manyfold',
    RUNNER_PROFILE,
    POD_RUNNER_PROFILE
])

// FNV-1a: stable across runtimes and free of node:crypto, because this module
// also ships to the browser.
const shortHash = (value: string): string => {
    let hash = 0x811c9dc5
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(36).slice(0, 6)
}

// The CLI profile an agent setup guide signs in to for a deployment other than
// the default API: one profile per API host (and port), so two deployments
// never share credentials and the same deployment always lands on the same
// profile. `https://api.example.com/api` → `example-com`,
// `http://localhost:7180/api` → `localhost-7180`.
export const cliProfileForApiUrl = (apiUrl: string): string => {
    const url = new URL(apiUrl)
    const host = url.hostname.toLowerCase()
    const base = isLoopbackHostname(host)
        ? 'localhost'
        : host.replace(/^api[.-]/, '')
    const raw = [base, url.port].filter(Boolean).join('-')
    let name =
        raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deployment'
    if (name.length > 32)
        name = `${name.slice(0, 25).replace(/-+$/, '')}-${shortHash(raw)}`
    return RESERVED_DEPLOYMENT_PROFILES.has(name) ? `${name}-api` : name
}
