import type {
    AgentModelConfig,
    FrameworkInstallSource
} from '@manyfold/shared'
import type { SpritesClient, SpritesLogger } from '@manyfold/sprites'

export interface BootstrapContext {
    agentId: string
    runtimeId: string
    userId: string
    spriteName: string
    mountPath: string
    client: SpritesClient
    logger: SpritesLogger
    execTimeoutMs?: number
    modelConfig?: AgentModelConfig | null
    // Version this framework should install (null = no resolvable target, so keep
    // the framework's built-in default: image binary / dist-tag / hardcoded clone).
    frameworkVersion?: string | null
    // Where `frameworkVersion` came from. 'explicit'/'admin' means someone asked
    // for it, so a failed install is fatal; 'latest' is the implicit default and
    // degrades to whatever the sprite already has. See installFrameworkVersion.
    frameworkVersionSource?: FrameworkInstallSource
    // For a git-installed framework, the `owner/name` to clone. Resolved in the
    // same settings read as `frameworkVersion` and carried as a value, so a
    // source switch mid-operation cannot leave a tag chosen from one repository
    // being cloned from another. Undefined for ctx builders that never clone.
    frameworkRepo?: string | null
    // User-configured environment variables in raw `.env` text. Merged UNDER the
    // framework env (framework keys win); only valid, non-reserved keys apply.
    envText?: string | null
    // Dashboard flags from the agent_runtimes row, threaded through every ctx
    // builder so a restart/rebuild never silently reverts a user's toggle to
    // the bootstrap-time default (openclaw control UI: true, hermes dashboard:
    // false). Undefined = caller predates the toggle feature; bootstraps fall
    // back to those defaults.
    controlUiEnabled?: boolean
    dashboardEnabled?: boolean
}

export interface BootstrapResult {
    homeDir?: string
    // Framework CLI version actually on PATH after the bootstrap installed (or
    // deliberately kept) it. Persisted onto the runtime row so a fresh agent
    // shows a version without waiting for a probe.
    frameworkVersion?: string | null
}

export interface FrameworkBootstrap {
    framework: 'claude-code' | 'codex' | 'gemini-cli'
    run(ctx: BootstrapContext, credentials: unknown): Promise<BootstrapResult>
}

export class BootstrapError extends Error {
    readonly step: string
    readonly cause?: unknown
    constructor(step: string, message: string, cause?: unknown) {
        super(message)
        this.name = 'BootstrapError'
        this.step = step
        this.cause = cause
    }
}
