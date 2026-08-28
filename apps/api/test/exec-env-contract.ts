import type {
    AgentFramework,
    AgentRuntime
} from '@manyfold/shared'

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
    // Sprite turn carried by that sprite's own runner: the transport swaps to
    // DaemonExecDriver while `runtime` stays 'sprites'.
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

export interface ExecEnvSurface {
    framework: AgentFramework
    runtime: AgentRuntime
    transport: ExecTransport
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
        transport: 'sprite-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'wrapper-prepend',
        resume: 'transparent-reattach'
    },
    {
        framework: 'claude-code',
        runtime: 'sprites',
        transport: 'runner-exec',
        gatedBy: ['MF_SPRITE_RUNNER_AGENTS'],
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: 'The swapped transport must carry the same baseEnv as the sprite driver it replaced (#581). Its argv is bare `claude`: the activation dir has to already be on the runner process PATH, which the sprite bootstrap now guarantees through the managed profile block rather than this cell (#611).'
    },
    {
        framework: 'claude-code',
        runtime: 'k8s',
        transport: 'pod-exec',
        identity: 'pod-secret',
        connections: 'none',
        extras: 'none',
        providerCreds: 'pod-secret',
        path: 'image-env',
        resume: 'none',
        note: 'Connection env and the agent extras reach sprites only; on k8s neither is provisioned into the Secret.'
    },
    {
        framework: 'claude-code',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec-model-config',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: 'A coding daemon turn spawns per exec, so the factory hands it the same identity + connection + extras base env a sprite turn gets (#781). Model creds ride the request env and win over the base env.'
    },
    {
        framework: 'codex',
        runtime: 'sprites',
        transport: 'sprite-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'sprite-resident',
        path: 'wrapper-prepend',
        resume: 'transparent-reattach',
        note: 'Sprite codex authenticates from its own ~/.codex written at bootstrap, so no credential env rides the turn.'
    },
    {
        framework: 'codex',
        runtime: 'sprites',
        transport: 'runner-exec',
        gatedBy: ['MF_SPRITE_RUNNER_AGENTS'],
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'sprite-resident',
        path: 'daemon-ambient',
        resume: 'attach-no-env'
    },
    {
        framework: 'codex',
        runtime: 'k8s',
        transport: 'pod-exec',
        identity: 'pod-secret',
        connections: 'none',
        extras: 'none',
        providerCreds: 'pod-secret',
        path: 'image-env',
        resume: 'none'
    },
    {
        framework: 'codex',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec-model-config',
        path: 'daemon-ambient',
        resume: 'attach-no-env'
    },
    {
        framework: 'gemini-cli',
        runtime: 'sprites',
        transport: 'sprite-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'adapter-bootstrap',
        resume: 'transparent-reattach',
        note: 'Gemini always wraps its argv in its own auth bootstrap, which prepends the activation dir itself — so this cell keeps the guarantee even where the driver wrapper is absent.'
    },
    {
        framework: 'gemini-cli',
        runtime: 'sprites',
        transport: 'runner-exec',
        gatedBy: ['MF_SPRITE_RUNNER_AGENTS'],
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'adapter-bootstrap',
        resume: 'attach-no-env'
    },
    {
        framework: 'gemini-cli',
        runtime: 'k8s',
        transport: 'pod-exec',
        identity: 'pod-secret',
        connections: 'none',
        extras: 'none',
        providerCreds: 'pod-secret',
        path: 'adapter-bootstrap',
        resume: 'none'
    },
    {
        framework: 'gemini-cli',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'daemon-local',
        path: 'adapter-bootstrap',
        resume: 'attach-no-env',
        note: 'Unlike claude and codex, gemini resolves no platform provider credentials on a daemon runtime at all — the daemon CLI uses its own auth. Identity, connection and extras env still ride each exec.'
    }
]

// Service frameworks run as a resident process started at bootstrap, so a turn
// is normally an HTTP call rather than a spawn. The daemon-carried transports
// exist so the socket that would cancel the run on close lives somewhere that
// outlives an API restart.
const serviceSurfaces: readonly ExecEnvSurface[] = [
    {
        framework: 'openclaw',
        runtime: 'sprites',
        transport: 'gateway-http',
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'none'
    },
    {
        framework: 'openclaw',
        runtime: 'sprites',
        transport: 'turn-rpc',
        gatedBy: [
            'MF_SPRITE_RUNNER_AGENTS',
            'MF_OPENCLAW_TURN_RPC',
            'daemon:turn.openclaw'
        ],
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'attach-no-env',
        payloadEnvKeys: [],
        note: 'The payload carries the gateway URL, token and request body; the runner holds the SSE socket. No env channel exists on this transport.'
    },
    {
        framework: 'openclaw',
        runtime: 'k8s',
        transport: 'gateway-http',
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'none'
    },
    {
        framework: 'openclaw',
        runtime: 'daemon',
        transport: 'daemon-exec',
        identity: 'daemon-local',
        connections: 'none',
        extras: 'none',
        providerCreds: 'daemon-local',
        path: 'daemon-ambient',
        resume: 'attach-no-env',
        note: 'A daemon openclaw turn spawns the CLI rather than calling a gateway, and dispatches no env at all: the factory gates its base env to coding frameworks because this turn payload has no env channel a resident openclaw would read (#783 owns adding one). It resumes by replaying the buffered CLI stdout under the exec ref it pinned, which is the assistant message id (#666), so the replay is a second read of one run rather than a second run.'
    },
    {
        framework: 'hermes',
        runtime: 'sprites',
        transport: 'turn-rpc',
        gatedBy: ['daemon:turn.hermes'],
        capabilityCheckedAt: 'resolution',
        identity: 'none',
        connections: 'none',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'not-applicable',
        resume: 'attach-no-env',
        payloadEnvKeys: ['HERMES_YOLO_MODE', 'OPENROUTER_API_KEY'],
        note: 'The preferred sprite transport (unconditional since the ACP unification). The runner daemon was started detached from a plain exec session, so the resident gateway service env never reaches the child it spawns: agent extras and the provider alias key must ride the payload. The alias key follows the primary provider; OPENROUTER_API_KEY is the harness marker shape.'
    },
    {
        framework: 'hermes',
        runtime: 'sprites',
        transport: 'sprite-exec',
        identity: 'per-exec',
        connections: 'per-exec',
        extras: 'per-exec',
        providerCreds: 'per-exec',
        path: 'wrapper-prepend',
        resume: 'none',
        note: 'The no-runner fallback since gateway-http chat was retired: the API drives `hermes acp` over the duplex sprite exec channel. Same protocol as every other hermes turn; the API owning the client is exactly why it is not resumable.'
    },
    {
        framework: 'hermes',
        runtime: 'k8s',
        transport: 'pod-exec',
        identity: 'pod-secret',
        connections: 'none',
        extras: 'none',
        providerCreds: 'per-exec',
        path: 'image-env',
        resume: 'none',
        note: 'The only k8s hermes transport since gateway-http chat was retired. The pod Secret carries HERMES_* but the alias key hermes actually reads is re-exported only inside the container entrypoint, which an exec session never runs — so the alias rides each exec. Extras are not in the Secret at all (#782 owns k8s Environment delivery).'
    },
    {
        framework: 'hermes',
        runtime: 'daemon',
        transport: 'turn-rpc',
        gatedBy: ['daemon:turn.hermes'],
        identity: 'daemon-local',
        connections: 'none',
        extras: 'per-exec',
        providerCreds: 'daemon-local',
        path: 'not-applicable',
        resume: 'attach-no-env',
        payloadEnvKeys: ['HERMES_YOLO_MODE'],
        note: 'Unlike openclaw, a daemon hermes turn is carried by the same turn.start transport as a runner turn — and its payload env channel is what carries the agent extras on a BYOD daemon (#781). A daemon without turn.hermes is refused with a typed upgrade error: the in-API pipe fallback was retired with the ACP unification (#427).'
    },
    {
        framework: 'narranexus',
        runtime: 'sprites',
        transport: 'gateway-http',
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'none'
    },
    {
        framework: 'narranexus',
        runtime: 'sprites',
        transport: 'turn-rpc',
        gatedBy: [
            'MF_SPRITE_RUNNER_AGENTS',
            'MF_OPENCLAW_TURN_RPC',
            'daemon:turn.openclaw'
        ],
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'attach-no-env',
        payloadEnvKeys: [],
        note: 'NarraNexus inherits the openclaw transport wholesale, including its gate. Reaching this cell at all requires the registry the subclass must forward (#555).'
    },
    {
        framework: 'narranexus',
        runtime: 'k8s',
        transport: 'gateway-http',
        identity: 'none',
        connections: 'none',
        extras: 'service-env',
        providerCreds: 'service-env',
        path: 'not-applicable',
        resume: 'none'
    }
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
    path: 'not-applicable' as const,
    resume: 'none' as const
}))

export const execEnvSurfaces: readonly ExecEnvSurface[] = [
    ...codingSurfaces,
    ...serviceSurfaces,
    ...externalSurfaces
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
