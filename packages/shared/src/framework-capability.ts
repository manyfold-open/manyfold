import type { AgentFramework, AgentRuntime } from './constants'

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

export interface FrameworkCapability {
    kind: FrameworkKind
    runtimes: readonly AgentRuntime[]
    configHome?: FrameworkConfigHome
    mcp?: FrameworkMcpSupport
}

// Single source of truth for framework STATIC facts (ADR-0006). Behavioural
// per-framework differences (exec/file/terminal/chat adapters, bootstrap
// implementations) stay explicit in their own modules — only policy/facts live
// here. `runtimes` is the support set; sandbox/daemon/external all derive from it.
export const frameworkCapabilities: Record<AgentFramework, FrameworkCapability> = {
    'claude-code': {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: { rootId: 'claude-home', label: 'Claude config', subdir: '.claude' },
        mcp: {
            format: 'json',
            scopes: [
                { id: 'user', label: 'User', path: '~/.claude.json' },
                { id: 'project', label: 'Project', path: '<workspace>/.mcp.json' }
            ]
        }
    },
    codex: {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: { rootId: 'codex-home', label: 'Codex config', subdir: '.codex' },
        mcp: {
            format: 'toml',
            scopes: [
                { id: 'global', label: 'Global', path: '~/.codex/config.toml' }
            ]
        }
    },
    'gemini-cli': {
        kind: 'coding',
        runtimes: ['sprites', 'k8s', 'daemon'],
        configHome: { rootId: 'gemini-home', label: 'Gemini config', subdir: '.gemini' },
        mcp: {
            format: 'json',
            scopes: [
                { id: 'user', label: 'User', path: '~/.gemini/settings.json' }
            ]
        }
    },
    openclaw: { kind: 'service', runtimes: ['sprites', 'k8s', 'daemon'] },
    hermes: { kind: 'service', runtimes: ['sprites', 'k8s', 'daemon'] },
    narranexus: { kind: 'service', runtimes: ['sprites', 'k8s'] },
    dify: { kind: 'external', runtimes: ['external'] },
    langflow: { kind: 'external', runtimes: ['external'] },
    a2a: { kind: 'external', runtimes: ['external'] }
}

export const frameworkCapability = (
    framework: AgentFramework
): FrameworkCapability => frameworkCapabilities[framework]

export const supportsRuntime = (
    framework: AgentFramework,
    runtime: AgentRuntime
): boolean => frameworkCapabilities[framework].runtimes.includes(runtime)

export const isExternal = (framework: AgentFramework): boolean =>
    frameworkCapabilities[framework].kind === 'external'

export const frameworkMcpSupport = (
    framework: AgentFramework
): FrameworkMcpSupport | undefined => frameworkCapabilities[framework].mcp

export const isKnownMcpScope = (
    framework: AgentFramework,
    scopeId: string
): boolean =>
    (frameworkCapabilities[framework].mcp?.scopes ?? []).some(
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
// agent — registered it: either a service-kind framework's main service
// (hermes/openclaw/narranexus) or one of the auxiliary services above. Used
// to surface such services read-only on the host detail surface and to block
// their deletion.
export const isServiceFrameworkName = (name: string): boolean =>
    MANAGED_AUX_SERVICE_NAMES.has(name) ||
    (Object.keys(frameworkCapabilities) as AgentFramework[]).some(
        (framework) =>
            framework === name &&
            frameworkCapabilities[framework].kind === 'service'
    )

// Sprite activity tasks (`/v1/tasks`) registered by the Manyfold platform. The
// keep-alive lease service names its tasks `nca-<framework>-<unique>-<gen>`;
// pre-refactor fleets still carry legacy `<framework>-keepalive` leases whose
// fused renew loop would silently resurrect them after a delete. Shared by the
// sandbox Tasks keepAlive display flag and the task-deletion guard so the two
// can't drift.
export const PLATFORM_TASK_PREFIX = 'nca-'

export const isPlatformTaskName = (name: string): boolean =>
    name.startsWith(PLATFORM_TASK_PREFIX) ||
    (Object.keys(frameworkCapabilities) as AgentFramework[]).some(
        (framework) =>
            frameworkCapabilities[framework].kind === 'service' &&
            name === `${framework}-keepalive`
    )