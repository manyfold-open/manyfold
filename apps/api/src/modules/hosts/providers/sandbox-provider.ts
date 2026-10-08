import { Injectable, Logger } from '@nestjs/common'
import type {
    RuntimeProviderKind,
    SandboxHealthVerdict,
    SandboxServiceStatus
} from '@manyfold/shared'
import type {
    RuntimeHostPowerState,
    RuntimeHostProviderRef,
    RuntimeHostRow,
    RuntimeProvider,
    RuntimeProviderConfig
} from '@manyfold/db'

// What a runtime provider must implement (ADR-0037): the machine's lifecycle
// and a single bootstrap channel that installs `mf`, writes the host's bound
// token and starts the daemon. Everything that happens inside the machine
// afterwards goes through the host daemon's RPC and is provider-agnostic.
//
// Every mutating call is idempotent on (host.id, generation): running it twice
// under the same generation yields the same result, and a call made under an
// older generation than the host's current one is dropped
// (StaleGenerationError).
export interface SandboxProviderCapabilities {
    // The machine can be suspended and woken (sprites); pods cannot.
    suspend: boolean
    // Service frameworks get a public entry (publicUrl).
    publicService: boolean
}

export interface HostCreateSpec {
    name: string
    region?: string | null
    cpuMillicores?: number | null
    memoryMb?: number | null
    diskGb?: number | null
    // What the machine boots with (a pod's env Secret: the daemon's bound
    // token and the API URL). Providers whose machines start bare ignore it.
    env?: Record<string, string>
}

// What a caller that can lose the right to mutate mid-call hands the adapter
// (a fresh create whose ownership lease may lapse): checked before every
// remote mutation, and its signal bounds the remote requests.
export interface ProviderCallFence {
    assertActive(): Promise<void>
    signal?: AbortSignal
    // Bracket each remote request the adapter sends under the fence: one that
    // started and never settled leaves the caller unsure whether it took
    // effect.
    requestStarted?(): void
    requestSettled?(): void
}

export interface ProviderCall {
    host: RuntimeHostRow
    provider: RuntimeProvider
    generation: number
    fence?: ProviderCallFence
}

// An admin's credential for a new or updated provider row: the part that is
// secret, the non-secret part that becomes config, and whether it works.
export interface PreparedCredential {
    secret: string
    config: RuntimeProviderConfig
    health: CredentialHealth
}

export interface CredentialHealth {
    ok: boolean
    message: string
}

// What the provider reports about a machine's power: the host vocabulary,
// or `gone` when the provider has no such machine any more.
export type ProviderPowerState = RuntimeHostPowerState | 'gone'

// The provider's own verdict on a machine. `rawStatus` is what it answered,
// kept verbatim because a status the adapter does not know maps to `unknown`
// and someone has to be able to read what it was.
export interface ProviderHealthReport {
    verdict: SandboxHealthVerdict
    rawStatus: string
    reason: string | null
    elapsedMs: number | null
}

// One control-plane read of every machine a provider account holds, waking
// none of them: each host's listed power by host id — a host the listing does
// not show is absent — and the account's capacity where the provider reports
// one.
export interface ProviderObservation {
    power: Map<string, RuntimeHostPowerState>
    capacity: ProviderCapacity | null
}

// Counted over everything the account lists, ours or not; a limit the
// provider does not report is null, never 0 (which would read as "no room").
export interface ProviderCapacity {
    running: number
    suspended: number
    stopped: number
    runningLimit: number | null
    suspendedLimit: number | null
}

// A provider-native exec session nothing is attached to any more, ended.
export interface ReapedSession {
    sessionId: string
    // The argv head only: the arguments may carry user paths.
    command: string
    tty: boolean
    idleMs: number
    // Since it started; null without a usable start.
    ageMs: number | null
    // Idle past the window, or a TTY session older than it.
    reason: 'idle' | 'age'
}

export interface ProviderExecResult {
    exitCode: number
    stdout: string
    stderr: string
}

// How the provider-native exec failed when the endpoint itself is at fault
// (#730): the exec-health breaker counts these against the host.
export type ExecEndpointFailureClass =
    | 'handshake_5xx'
    | 'transport_error'
    | 'timeout'

export interface ExecEndpointFailure {
    failureClass: ExecEndpointFailureClass
    // Only a status-carrying handshake failure has one; a bare transport error
    // never invents it.
    upstreamStatus?: number
}

// What the core may learn from an error an adapter threw without knowing the
// provider's client: a class for logs and audits, whether the provider-native
// exec failed before its connection opened (the command never reached the
// machine), and the endpoint failure the exec-health breaker counts — null
// for one it must not (an account-wide refusal, a fact about the request).
export interface ProviderErrorFacts {
    errorClass: string
    beforeOpen: boolean
    execFailure: ExecEndpointFailure | null
    // One line safe to show a user in a failure reason, when the adapter has
    // a better one than the error's own message.
    summary?: string
}

// A process the provider's own supervisor keeps on the machine: one its owner
// or an agent registered, or the platform's own (isPlatformServiceName).
export interface ProviderService {
    name: string
    command: string
    httpPort: number | null
    status: SandboxServiceStatus
    pid: number | null
    startedAt: string | null
    error: string | null
}

// An activity lease on the machine (ADR-0038): while it is listed the machine
// is not suspended. The platform's holds are among them, next to any an agent
// took.
export interface AwakeLease {
    name: string
    startedAt: string | null
    expiresAt: string | null
}

// A lease still listed after its release: something inside the machine took
// it again, or the release did not go through.
export class AwakeLeaseStillHeldError extends Error {
    constructor(readonly leaseName: string) {
        super(`awake lease ${leaseName} is still listed after its release`)
        this.name = 'AwakeLeaseStillHeldError'
    }
}

// The process the provider's own supervisor keeps running on the machine: the
// daemon's restart loop. What it runs is the core's; how it is kept is the
// provider's.
export interface SupervisedProcess {
    name: string
    command: string[]
    env: Record<string, string>
}

export interface SandboxProvider {
    readonly kind: RuntimeProviderKind
    readonly capabilities: SandboxProviderCapabilities
    // The admin surface for provider rows (ADR-0037): how a credential splits
    // into secret and config and whether it works, before any row exists; the
    // config an admin's patch leaves; whether a row's credential still works;
    // and forgetting what the adapter built from a row that changed.
    prepareCredential(
        credential: string,
        config: Record<string, unknown>
    ): Promise<PreparedCredential>
    mergeConfig(
        current: RuntimeProviderConfig,
        patch: Record<string, unknown>
    ): RuntimeProviderConfig
    checkCredential(provider: RuntimeProvider): Promise<CredentialHealth>
    forget?(providerId: string): void
    create(
        args: ProviderCall & { spec: HostCreateSpec }
    ): Promise<RuntimeHostProviderRef>
    destroy(args: ProviderCall): Promise<void>
    // The machine's power from the provider's control plane; never wakes it.
    power(args: Omit<ProviderCall, 'generation'>): Promise<ProviderPowerState>
    // The provider's health check on one machine, or `gone` when it has no
    // such machine. Unlike power(), it can act: a provider may repair what it
    // finds (sprites restarts a stopped machine), so it counts as a wake and
    // is never called on a machine that is working.
    checkHealth?(
        args: Omit<ProviderCall, 'generation'>
    ): Promise<ProviderHealthReport | 'gone'>
    // A provider whose account lists all its machines in one read offers it,
    // and the power sync reads that instead of one power() per host.
    observe?(args: {
        provider: RuntimeProvider
        hosts: RuntimeHostRow[]
    }): Promise<ProviderObservation>
    // Ends the provider-native exec sessions nothing has touched for longer
    // than any legitimate exec: a live one can keep the machine running, and
    // billed, forever. A machine the provider no longer has has none.
    reapIdleSessions?(
        args: Omit<ProviderCall, 'generation'>,
        opts: { maxIdleMs: number }
    ): Promise<ReapedSession[]>
    wake(args: ProviderCall): Promise<void>
    suspend?(args: ProviderCall): Promise<void>
    // The provider-native exec: a login-shell script run inside the machine.
    // The only thing it is for is the daemon's own bring-up (install `mf`,
    // register with the bound token, start) and the read-only probes around
    // it; framework installs and everything else go through the daemon.
    bootstrap(
        args: ProviderCall & {
            script: string
            stdin?: string
            timeoutMs?: number
        }
    ): Promise<ProviderExecResult>
    // The provider's activity lease (ADR-0038): while it is held the machine is
    // not suspended, and acquiring it resumes a suspended machine. Create or
    // renew, so a retry is not a failure. Providers whose machines never sleep
    // leave both out and the core holds nothing.
    holdAwake?(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string; ttl: string }
    ): Promise<void>
    // Throws AwakeLeaseStillHeldError when the lease is listed after it.
    releaseAwake?(
        args: Omit<ProviderCall, 'generation'>,
        lease: { name: string }
    ): Promise<void>
    // The machine's activity leases. Reading them runs inside the machine,
    // which resumes a suspended one; a held lease keeps the machine running,
    // so a caller that must not wake it has nothing to read on one that is
    // not.
    listAwake?(args: Omit<ProviderCall, 'generation'>): Promise<AwakeLease[]>
    // The services the provider's own supervisor keeps on the machine, read
    // from its control plane (no wake). A provider without such a supervisor
    // leaves these out. Removing one ends its processes; stopping keeps its
    // definition and answers false when the supervisor refused (another
    // service needs it). A service already gone counts as removed or stopped.
    listServices?(args: Omit<ProviderCall, 'generation'>): Promise<ProviderService[]>
    removeService?(
        args: Omit<ProviderCall, 'generation'>,
        name: string
    ): Promise<void>
    stopService?(
        args: Omit<ProviderCall, 'generation'>,
        name: string
    ): Promise<boolean>
    // Keeps the daemon's restart loop running under the provider's own
    // supervisor, which is what starts it again after the machine's
    // environment restarts. A machine whose main process is that loop (a
    // pod's boot script) leaves it out. Idempotent: an unchanged definition
    // that runs is left alone.
    superviseDaemon?(args: ProviderCall, process: SupervisedProcess): Promise<void>
    // Routes a service framework's public entry to the port inside the
    // machine its daemon's service serves; a null port withdraws that
    // framework's route. How is the provider's: a sprite has one public URL
    // for its one framework, a pod gives each framework a hostname of its own.
    publishPort?(
        args: Omit<ProviderCall, 'generation'>,
        route: { framework: string; port: number | null }
    ): Promise<void>
    publicUrl?(
        args: Omit<ProviderCall, 'generation'> & {
            framework: string
            port: number
        }
    ): string | null
    // Opens the machine's outbound access to these domains where its network
    // policy restricts it; a policy that already allows them is left alone.
    allowEgress?(
        args: Omit<ProviderCall, 'generation'>,
        domains: readonly string[]
    ): Promise<void>
    // Facts about an error this adapter's client threw; null for one it does
    // not recognize as its own.
    describeError?(err: unknown): ProviderErrorFacts | null
}

export class StaleGenerationError extends Error {
    constructor(hostId: string, generation: number, current: number) {
        super(
            `host ${hostId} generation ${generation} is stale (current ${current})`
        )
        this.name = 'StaleGenerationError'
    }
}

// Adapters register themselves from their module constructor, the way
// CapabilitiesRegistry entries do, so HostsModule stays free of adapter
// imports and an edition can add a provider without touching the core list.
@Injectable()
export class SandboxProviderRegistry {
    private readonly log = new Logger(SandboxProviderRegistry.name)
    private readonly byKind = new Map<RuntimeProviderKind, SandboxProvider>()

    register(provider: SandboxProvider): void {
        if (this.byKind.has(provider.kind))
            throw new Error(
                `sandbox provider '${provider.kind}' registered twice`
            )
        this.byKind.set(provider.kind, provider)
        this.log.log(`sandbox provider registered kind=${provider.kind}`)
    }

    for(kind: RuntimeProviderKind): SandboxProvider {
        const provider = this.byKind.get(kind)
        if (!provider) throw new Error(`no sandbox provider registered for ${kind}`)
        return provider
    }

    has(kind: RuntimeProviderKind): boolean {
        return this.byKind.has(kind)
    }

    kinds(): RuntimeProviderKind[] {
        return [...this.byKind.keys()]
    }

    // An error carries no provider, and the adapter that threw it is the only
    // one that recognizes it.
    describeError(err: unknown): ProviderErrorFacts | null {
        for (const provider of this.byKind.values()) {
            const facts = provider.describeError?.(err)
            if (facts) return facts
        }
        return null
    }
}
