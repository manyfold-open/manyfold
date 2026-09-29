import type { AgentRuntime } from './constants'
import type { AgentFramework } from './frameworks/core'
import {
    frameworkDefinition,
    requireFrameworkDefinition
} from './frameworks/registry'

export type FrameworkKind = 'coding' | 'service' | 'external'

export interface FrameworkConfigHome {
    rootId: string
    label: string
    subdir: string
}

export type McpScopeId = 'user' | 'project' | 'global'
export type McpConfigFormat = 'json' | 'toml'

export interface FrameworkMcpScope {
    id: McpScopeId
    label: string
    // Display path of the sprite config file this scope writes to (`~` = the
    // agent's $HOME, `<workspace>` = its workspace dir). Shown in the MCP editor.
    // Keep in sync with the absolute-path resolver in api mcp-config.ts `targetFor`.
    path: string
}

// Which MCP scopes a framework exposes, and the native config syntax the user
// edits. Single source of truth consumed by both the API materializer and the
// web MCP editor. Only coding frameworks whose CLI reads MCP servers carry this.
export interface FrameworkMcpSupport {
    format: McpConfigFormat
    scopes: readonly FrameworkMcpScope[]
}

// Framework STATIC facts (ADR-0006), read from the framework registry
// (ADR-0034). Behavioural per-framework differences (exec/file/terminal/chat
// adapters, bootstrap implementations) stay explicit in their own modules.
// `runtimes` is the support set; sandbox/daemon/external all derive from it.
export interface FrameworkCapability {
    kind: FrameworkKind
    runtimes: readonly AgentRuntime[]
    configHome?: FrameworkConfigHome
    mcp?: FrameworkMcpSupport
}

// Throws UnknownFrameworkError for an id this build does not register.
export const frameworkCapability = (
    framework: AgentFramework
): FrameworkCapability => requireFrameworkDefinition(framework)

// undefined for an id this build does not register, where frameworkCapability
// throws: what display code asks of a framework read off an API row.
export const frameworkKind = (
    framework: AgentFramework
): FrameworkKind | undefined => frameworkDefinition(framework)?.kind

export const supportsRuntime = (
    framework: AgentFramework,
    runtime: AgentRuntime
): boolean =>
    frameworkDefinition(framework)?.runtimes.includes(runtime) ?? false

export const isExternal = (framework: AgentFramework): boolean =>
    frameworkDefinition(framework)?.kind === 'external'

// The runtime manages its own model credentials in its own UI
// (FrameworkDefinition.credentials 'runtime-ui'); Manyfold stores none.
export const credentialsManagedByRuntime = (
    framework: AgentFramework
): boolean => frameworkDefinition(framework)?.credentials === 'runtime-ui'

// Every agent opens the runtime's own UI, with no toggle in front of it
// (FrameworkDefinition.nativeUi 'always').
export const nativeUiAlwaysOn = (framework: AgentFramework): boolean =>
    frameworkDefinition(framework)?.nativeUi === 'always'

// The framework runs its own schedules and the platform runs none for its
// agents (FrameworkDefinition.schedules 'mirrored').
export const schedulesMirrored = (framework: AgentFramework): boolean =>
    frameworkDefinition(framework)?.schedules === 'mirrored'

export const frameworkMcpSupport = (
    framework: AgentFramework
): FrameworkMcpSupport | undefined => frameworkDefinition(framework)?.mcp

export const isKnownMcpScope = (
    framework: AgentFramework,
    scopeId: string
): boolean =>
    (frameworkDefinition(framework)?.mcp?.scopes ?? []).some(
        (scope) => scope.id === scopeId
    )

// The services of the hermes dashboard, run by the host's daemon beside the
// gateway while the dashboard is on.
export const HERMES_DASHBOARD_SERVICE = 'hermes-dashboard'
export const HERMES_PROXY_SERVICE = 'hermes-proxy'

// The two sprites.dev services Manyfold registers on a sandbox: the daemon's
// restart loop (every framework service runs under the daemon) and the stub
// that routes the sandbox's public URL to a port inside it. Everything else
// on the sprite's Services API is the user's or the agent's. Used to show
// them read-only on the sandbox surface and to keep a delete or a stop off
// them.
export const SANDBOX_DAEMON_SERVICE = 'mf-daemon'
export const SANDBOX_PORT_SERVICE = 'mf-port'

export const isPlatformServiceName = (name: string): boolean =>
    name === SANDBOX_DAEMON_SERVICE || name === SANDBOX_PORT_SERVICE

// Sprite activity tasks (`/v1/tasks`) registered by the Manyfold platform. The
// awake hold an API instance keeps while it works on the machine (ADR-0038) is
// `mf-hold-<instance>`; the user's keep-awake switch holds `mf-keep`. Machines
// not yet swept by the keep-awake cutover still carry the in-VM lease loop's
// `nca-...` tasks and older `<framework>-keepalive` ones, whose loop would
// resurrect them after a delete. Shared by the sandbox Tasks keepAlive display
// flag and the task-deletion guard so the two can't drift.
export const PLATFORM_TASK_PREFIX = 'nca-'

// One per host: the switch, not an instance, owns it.
export const AWAKE_KEEP_TASK_NAME = 'mf-keep'

// A sprite is one host, so an instance tag alone names that instance's hold.
export const AWAKE_HOLD_TASK_PREFIX = 'mf-hold-'

const AWAKE_HOLD_TASK_NAME = /^mf-hold-[0-9a-f]{8}$/

const LEGACY_KEEPALIVE_SUFFIX = '-keepalive'

export const isAwakeHoldTaskName = (name: string): boolean =>
    AWAKE_HOLD_TASK_NAME.test(name)

export const isPlatformTaskName = (name: string): boolean =>
    name === AWAKE_KEEP_TASK_NAME ||
    name.startsWith(PLATFORM_TASK_PREFIX) ||
    isAwakeHoldTaskName(name) ||
    (name.endsWith(LEGACY_KEEPALIVE_SUFFIX) &&
        frameworkDefinition(name.slice(0, -LEGACY_KEEPALIVE_SUFFIX.length))
            ?.kind === 'service')
