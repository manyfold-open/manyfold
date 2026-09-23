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

// Auxiliary sprite services Manyfold registers alongside a framework's main
// service. Single source shared by the hermes bootstrap (which creates them)
// and the delete-guard below (which must protect them) so the lists can't
// drift.
export const HERMES_DASHBOARD_SERVICE = 'hermes-dashboard'
export const HERMES_PROXY_SERVICE = 'hermes-proxy'

const MANAGED_AUX_SERVICE_NAMES: ReadonlySet<string> = new Set([
    HERMES_DASHBOARD_SERVICE,
    HERMES_PROXY_SERVICE
])

// A sprites.dev service name is Manyfold-managed when the platform — not the
// agent — registered it: either a service-kind framework's main service (named
// after the framework) or one of the auxiliary services above. Used to surface
// such services read-only on the host detail surface and to block their
// deletion.
export const isServiceFrameworkName = (name: string): boolean =>
    MANAGED_AUX_SERVICE_NAMES.has(name) ||
    frameworkDefinition(name)?.kind === 'service'

// Sprite activity tasks (`/v1/tasks`) registered by the Manyfold platform. The
// keep-alive lease service names its tasks `nca-<framework>-<unique>-<gen>`;
// pre-refactor fleets still carry legacy `<framework>-keepalive` leases whose
// fused renew loop would silently resurrect them after a delete. Shared by the
// sandbox Tasks keepAlive display flag and the task-deletion guard so the two
// can't drift.
export const PLATFORM_TASK_PREFIX = 'nca-'

const LEGACY_KEEPALIVE_SUFFIX = '-keepalive'

export const isPlatformTaskName = (name: string): boolean =>
    name.startsWith(PLATFORM_TASK_PREFIX) ||
    (name.endsWith(LEGACY_KEEPALIVE_SUFFIX) &&
        frameworkDefinition(name.slice(0, -LEGACY_KEEPALIVE_SUFFIX.length))
            ?.kind === 'service')
