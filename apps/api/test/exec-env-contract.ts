import type { AgentFramework, AgentRuntime } from '@manyfold/shared'

// Test-only mirror of what a chat turn's process is launched with, declared per
// execution surface. It stays outside src so the API build does not ship a
// contract that production never reads.
//
// The agent loop runs inside a CLI the platform does not control, so the whole
// contract is the assembly of argv + env + PATH. That assembly differs by
// framework AND runtime AND transport, and each adapter implements its own cell
// imperatively — which is why gaps arrive one cell at a time (#581 dropped the
// identity env on exactly one transport; #555 made exactly one transport
// unreachable). This table states what each cell is supposed to do so the
// matrix suite can check every cell instead of the three anyone remembered.
//
// Scope: what the API injects AT DISPATCH. Ambient state a surface may also
// have (the sprite shell profile, an image's ENV PATH, the user's own daemon
// environment) is named by the mechanism values but is not asserted here; the
// bootstrap/install surfaces own it (#438, and #611's `buildManagedPathScript`
// in @manyfold/shared, asserted by packages/shared/test/exec-env-path.test.ts).
//
// This is a checked mirror, not a source production reads. The matrix suite
// proves both directions: every row matches real adapter behaviour, and every
// transport observed at the seam has a row.

export type ExecTransport =
    // Sprite WSS exec through SpritesExecDriver.
    | 'sprite-exec'
    // Turn carried by the managed runner living inside the runtime the platform
    // owns: the transport swaps to DaemonExecDriver while `runtime` stays
    // 'sprites' (a runner we installed into the VM) or 'k8s' (the daemon that
    // ships in the agent image). The swap is the same one either way.
    | 'runner-exec'
    // The user's own daemon (BYOD), via DaemonExecDriver with no base env.
    | 'daemon-exec'
    // K8sExecDriver against the agent pod.
    | 'pod-exec'
    // daemon `turn.start`: the runner spawns and drives the framework itself.
    | 'turn-rpc'
    // HTTP to a resident service (the framework's own gateway).
    | 'gateway-http'
    // HTTP to an external provider; never reaches ExecDriverFactory.
    | 'provider-http'

export type EnvInjection =
    // The API merges the group into the dispatch env for every turn.
    | 'per-exec'
    // Injected per turn only when a platform model config is attached; the
    // surface's own ambient auth is used otherwise.
    | 'per-exec-model-config'
    // Lives on the sprite (config home written at bootstrap), not per turn.
    | 'sprite-resident'
    // Baked into the pod Secret when the runtime is provisioned.
    | 'pod-secret'
    // Baked into the sprite service definition when the service is bootstrapped.
    | 'service-env'
    // The daemon process's own environment, owned by the user's machine.
    | 'daemon-local'
    // Intentionally not delivered on this surface. Declared, not silent.
    | 'none'

export type PathStrategy =
    // The sprite driver's bash wrapper prepends the activation dir.
    | 'wrapper-prepend'
    // The adapter's own cmd carries the prepend.
    | 'adapter-bootstrap'
    // The container image's ENV PATH is authoritative; a login shell would
    // clobber it, so the driver deliberately does not prepend.
    | 'image-env'
    // Nothing prepends here: the child inherits the carrying process's PATH.
    // The cell value did not move when #611 was fixed, and that is the honest
    // answer — dispatch still injects nothing. What changed is what "ambient"
    // is worth: a sprite runner is started from a login shell, so the managed
    // profile block now makes the activation dir first by construction instead
    // of by luck. On a BYOD daemon the PATH remains the user's own machine's.
    | 'daemon-ambient'
    // No argv is spawned by Manyfold on this surface.
    | 'not-applicable'

export type ResumeSemantics =
    // exec.resume / turn replay re-attaches to a live process; carries no env
    // because nothing is re-spawned.
    | 'attach-no-env'
    // The sprite exec survives a WSS drop and the driver re-attaches to it.
    | 'transparent-reattach'
    // No resume path on this surface.
    | 'none'

// Who resolves the vendor sign-in an execution runs under:
//   host-resolved — the daemon composes a runtime auth profile's context from
//                   the `authSelection` the API stamps on the exec payload
//   ambient       — the host's native sign-in; a profile-bound agent is REFUSED
//                   on this surface rather than downgraded to it
//   none          — the framework has no vendor sign-in concept here
export type AuthResolution = 'host-resolved' | 'ambient' | 'none'

export interface ExecEnvSurface {
    framework: AgentFramework
    runtime: AgentRuntime
    transport: ExecTransport
    auth: AuthResolution
    // Flags and daemon capabilities that must all hold for this cell to be
    // reachable. Declared as facts; the gate predicates themselves stay pinned
    // by the per-adapter transport tests. `daemon:<feature>` is a client
    // feature the carrying daemon must advertise.
    gatedBy?: readonly string[]
    // Where a `daemon:` gate is enforced. 'dispatch' (default): the adapter
    // checks before sending the RPC. 'resolution': the carrier is only handed
    // to the adapter after the check (runner resolution), so the adapter seam
    // deliberately trusts it — pinned by runner-transport-routing.test.ts.
    capabilityCheckedAt?: 'dispatch' | 'resolution'
    // MF_API_TOKEN / MF_AGENT_ID / MF_API_URL / MF_DEPLOY_ENV.
    identity: EnvInjection
    // Connection-derived env (GH_TOKEN, GIT_CONFIG_*, CLOUDFLARE_*).
    connections: EnvInjection
    // The agent's user-defined env text.
    extras: EnvInjection
    // Framework provider credentials.
    providerCreds: EnvInjection
    path: PathStrategy
    resume: ResumeSemantics
    // turn-rpc only: the exact env keys the RPC payload carries.
    payloadEnvKeys?: readonly string[]
    // Why an intentional absence or asymmetry is what it is.
    note?: string
}

// Coding frameworks share a shape: the factory builds one baseEnv (identity +
// connection env + extras) for sprites and for coding daemons, and hands it to
// whichever transport carries the turn. k8s identity is provisioned into the
// pod Secret, and a BYOD daemon keeps its own PATH. They differ only in where
// provider credentials come from and in what puts the activation dir on PATH —
// which is exactly what the rows below record.
const codingSurfaces: readonly ExecEnvSurface[] = [

    {
        framework: 'claude-code',
        runtime: 'sprites',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: 'The swapped transport must carry the same baseEnv as the sprite driver it replaced (#581). Its argv is bare `claude`: the activation dir has to already be on the runner process PATH, which the sprite bootstrap now guarantees through the managed profile block rather than this cell (#611).'
    },

    {
        framework: 'claude-code',
        runtime: 'k8s',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'pod-secret',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: "The pod-runner cell. Everything the pod-exec row below declares absent arrives here instead: the daemon spawns per exec, so the factory hands the swapped transport the same identity + connection + extras base env a sprite runner turn carries (#581's shape, #782's gap). Provider creds stay on the pod Secret — the daemon inherits the container env and passes it to the child, so re-injecting them would only duplicate what is already there. 'daemon-ambient' is literal: the carrier's PATH is the image's ENV PATH, and nothing prepends."
    },
    {
        framework: 'claude-code',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec-model-config',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: 'A coding daemon turn spawns per exec, so the factory hands it the same identity + connection + extras base env a sprite turn gets (#781). Model creds ride the request env and win over the base env.'
    },

    {
        framework: 'codex',
        runtime: 'sprites',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'sprite-resident',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env'
    },

    {
        framework: 'codex',
        runtime: 'k8s',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'pod-secret',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: "Same shape as the claude-code pod-runner cell. The identity env matters more here than on a single-agent pod: the Secret's MF_AGENT_ID names whichever agent provisioned the pod, so on a pod carrying several agents only the per-exec value is right."
    },
    {
        framework: 'codex',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec-model-config',
        auth: 'host-resolved',
        path: 'daemon-ambient',
        resume: 'attach-no-env'
    },

    {
        framework: 'gemini-cli',
        runtime: 'sprites',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        auth: 'host-resolved',
        path: 'adapter-bootstrap',
        resume: 'attach-no-env'
    },

    {
        framework: 'gemini-cli',
        runtime: 'k8s',
        transport: 'runner-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'pod-secret',
        auth: 'host-resolved',
        // Not 'daemon-ambient' like its claude/codex siblings: gemini is the
        // one coding adapter whose argv is never bare — every transport gets
        // GEMINI_CLI_AUTH_BOOTSTRAP, which prepends the activation dir itself.
        // Declaring the sibling value here is what the matrix caught.
        path: 'adapter-bootstrap',
        resume: 'attach-no-env',
        note: "Same shape as the claude-code pod-runner cell, except that gemini carries its own PATH prepend on every surface rather than inheriting the carrier's."
    },
    {
        framework: 'gemini-cli',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'daemon-local',
        auth: 'host-resolved',
        path: 'adapter-bootstrap',
        resume: 'attach-no-env',
        note: 'Unlike claude and codex, gemini resolves no platform provider credentials on a daemon runtime at all — the daemon CLI uses its own auth. Identity, connection and extras env still ride each exec.'
    }
]

const serviceSurfaces: readonly ExecEnvSurface[] = [
    ...(['daemon', 'sprites', 'k8s'] as const).map((runtime): ExecEnvSurface => ({
        framework: 'openclaw', runtime, transport: 'turn-rpc',
        gatedBy: ['daemon:turn.openclaw.acp'],
        identity: 'none', connections: 'none', extras: 'none',
        providerCreds: runtime === 'daemon' ? 'daemon-local' : 'service-env',
        auth: 'none', path: 'not-applicable', resume: 'attach-no-env', payloadEnvKeys: []
    })),
    ...(['daemon', 'sprites', 'k8s'] as const).map((runtime): ExecEnvSurface => ({
        framework: 'hermes', runtime, transport: 'turn-rpc',
        gatedBy: ['daemon:turn.hermes'],
        identity: runtime === 'daemon' ? 'daemon-local' : 'none',
        connections: 'none', extras: 'per-exec',
        providerCreds: runtime === 'daemon' ? 'daemon-local' : 'per-exec',
        auth: 'none', path: 'not-applicable', resume: 'attach-no-env',
        payloadEnvKeys: runtime === 'daemon' ? ['HERMES_YOLO_MODE'] : ['HERMES_YOLO_MODE', 'OPENROUTER_API_KEY']
    })),
    ...(['sprites', 'k8s'] as const).map((runtime): ExecEnvSurface => ({
        framework: 'narranexus', runtime, transport: 'turn-rpc',
        gatedBy: ['daemon:turn.openclaw'],
        identity: 'none', connections: 'none', extras: 'service-env', providerCreds: 'service-env',
        auth: 'none', path: 'not-applicable', resume: 'attach-no-env', payloadEnvKeys: []
    }))
]

// External frameworks are HTTP to somebody else's runtime. Manyfold launches no
// process, so every group is an intentional absence rather than a gap.
const externalSurfaces: readonly ExecEnvSurface[] = (
    ['dify', 'langflow', 'a2a'] as const
).map((framework) => ({
    framework,
    runtime: 'external' as const,
    transport: 'provider-http' as const,
    identity: 'none' as const,
    connections: 'none' as const,
    extras: 'none' as const,
    providerCreds: 'none' as const,
    auth: 'none' as const,
    path: 'not-applicable' as const,
    resume: 'none' as const
}))

export const execEnvSurfaces: readonly ExecEnvSurface[] = [
    ...codingSurfaces,
    ...serviceSurfaces,
    ...externalSurfaces
]

// The interactive terminal surfaces (ADR-0029 §3). Not a chat turn — no
// framework argv is dispatched, the user types — so not a row in the matrix
// above, but a shell the platform opens is where the user runs `mf` by hand
// and where the CLI session hooks fire, so it carries the same four-key
// identity a turn does, plus the terminal's own id as the hooks' switch.
// Pinned by terminal-env-contract.test.ts against terminalIdentityEnv and the
// daemon driver's pty.open payload.
export interface TerminalEnvSurface {
    runtime: 'sprites' | 'daemon'
    // MF_API_TOKEN / MF_AGENT_ID / MF_API_URL / MF_DEPLOY_ENV, minted and
    // composed per terminal session, over whatever the agent env carries.
    identity: 'per-session'
    // MF_TERMINAL_ID: present exactly when the terminal has a durable row.
    terminalId: 'per-session'
    note?: string
}

export const terminalEnvSurfaces: readonly TerminalEnvSurface[] = [
    {
        runtime: 'sprites',
        identity: 'per-session',
        terminalId: 'per-session',
        note: 'The sprite shell profile also exports MF_API_URL and MF_DEPLOY_ENV (sprite-resident, #438); the per-session values are the same ones, laid on the exec so a terminal never depends on the login shell having sourced them.'
    },
    {
        runtime: 'daemon',
        identity: 'per-session',
        terminalId: 'per-session',
        note: 'Used to inject only MF_AGENT_ID and MF_API_TOKEN, so `mf` run in the terminal fell back to whatever API the machine profile stored (ADR-0029 §3 closes that).'
    }
]

export const execEnvSurface = (
    framework: AgentFramework,
    runtime: AgentRuntime,
    transport: ExecTransport
): ExecEnvSurface | undefined =>
    execEnvSurfaces.find(
        (surface) =>
            surface.framework === framework &&
            surface.runtime === runtime &&
            surface.transport === transport
    )

export const execEnvSurfacesFor = (
    framework: AgentFramework,
    runtime: AgentRuntime
): readonly ExecEnvSurface[] =>
    execEnvSurfaces.filter(
        (surface) =>
            surface.framework === framework && surface.runtime === runtime
    )

export const execEnvSurfaceKey = (surface: {
    framework: AgentFramework
    runtime: AgentRuntime
    transport: ExecTransport
}): string => `${surface.framework} × ${surface.runtime} × ${surface.transport}`
