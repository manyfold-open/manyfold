export const agentFramework = {
    OPENCLAW: 'openclaw',
    HERMES: 'hermes',
    NARRA_NEXUS: 'narranexus',
    CLAUDE_CODE: 'claude-code',
    CODEX: 'codex',
    GEMINI_CLI: 'gemini-cli',
    DIFY: 'dify',
    LANGFLOW: 'langflow',
    A2A: 'a2a'
} as const

export type AgentFramework =
    (typeof agentFramework)[keyof typeof agentFramework]

export const agentRuntime = {
    SPRITES: 'sprites',
    K8S: 'k8s',
    DAEMON: 'daemon',
    EXTERNAL: 'external'
} as const

export type AgentRuntime = (typeof agentRuntime)[keyof typeof agentRuntime]

export const runtimeKindLabel = (kind: AgentRuntime): string => {
    switch (kind) {
        case 'k8s':
            return 'Cloud computer'
        case 'sprites':
            return 'Stateful sandbox'
        case 'daemon':
            return 'Self-owned computer'
        case 'external':
            return 'External API'
    }
}

export const agentStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    STOPPED: 'stopped',
    FAILED: 'failed'
} as const

export type AgentStatus = (typeof agentStatus)[keyof typeof agentStatus]

export const agentRuntimeStatus = {
    PENDING: 'pending',
    READY: 'ready',
    FAILED: 'failed',
    STOPPED: 'stopped'
} as const

export type AgentRuntimeStatus =
    (typeof agentRuntimeStatus)[keyof typeof agentRuntimeStatus]

export const userRole = {
    USER: 'user',
    ADMIN: 'admin'
} as const

export type UserRole = (typeof userRole)[keyof typeof userRole]

export const spritesAccountStatus = {
    ENABLED: 'enabled',
    DISABLED: 'disabled'
} as const

export type SpritesAccountStatus =
    (typeof spritesAccountStatus)[keyof typeof spritesAccountStatus]

export const auditAction = {
    USER_DELETION_REQUESTED: 'user.deletion.requested',
    USER_DELETION_RESTORED: 'user.deletion.restored',
    USER_DELETION_EXECUTED: 'user.deletion.executed',
    AGENT_CREATE_STARTED: 'agent.create.started',
    AGENT_CREATE_SUCCEEDED: 'agent.create.succeeded',
    AGENT_CREATE_FAILED: 'agent.create.failed',
    AGENT_CREATE_K8S_STARTED: 'agent.create.k8s.started',
    AGENT_CREATE_K8S_SUCCEEDED: 'agent.create.k8s.succeeded',
    AGENT_CREATE_K8S_FAILED: 'agent.create.k8s.failed',
    AGENT_CREATE_EXTERNAL_STARTED: 'agent.create.external.started',
    AGENT_CREATE_EXTERNAL_SUCCEEDED: 'agent.create.external.succeeded',
    AGENT_CREATE_EXTERNAL_FAILED: 'agent.create.external.failed',
    EXTERNAL_AGENT_PROVIDER_CREATED: 'external_agent_provider.created',
    EXTERNAL_AGENT_PROVIDER_UPDATED: 'external_agent_provider.updated',
    EXTERNAL_AGENT_PROVIDER_DELETED: 'external_agent_provider.deleted',
    AGENT_DELETE_STARTED: 'agent.delete.started',
    AGENT_DELETE_SUCCEEDED: 'agent.delete.succeeded',
    AGENT_DELETE_FAILED: 'agent.delete.failed',
    AGENT_SANDBOX_STOP: 'agent.sandbox.stop',
    SANDBOX_STOP: 'sandbox.stop',
    AGENT_RUNTIME_CONTROL_UI_TOGGLED: 'agent_runtime.control_ui.toggled',
    AGENT_RUNTIME_CONTROL_UI_TOGGLE_FAILED:
        'agent_runtime.control_ui.toggle_failed',
    AGENT_RUNTIME_CONTROL_UI_URL_MINTED: 'agent_runtime.control_ui.url_minted',
    AGENT_RUNTIME_DASHBOARD_TOGGLED: 'agent_runtime.dashboard.toggled',
    AGENT_RUNTIME_DASHBOARD_TOGGLE_FAILED:
        'agent_runtime.dashboard.toggle_failed',
    AGENT_CREDENTIALS_UPDATED: 'agent.credentials.updated',
    AGENT_CREDENTIALS_REVEALED: 'agent.credentials.revealed',
    USER_RUNTIME_ACCESS_UPDATED: 'user.runtime_access.updated',
    SPRITES_ACCOUNT_CREATED: 'sprites.account.created',
    SPRITES_ACCOUNT_ROTATED: 'sprites.account.rotated',
    SPRITES_ACCOUNT_DISABLED: 'sprites.account.disabled',
    VOLUMES_GC_RUN: 'volumes.gc.run',
    DAEMON_TOKEN_ISSUED: 'daemon.token.issued',
    DAEMON_TOKEN_REVOKED: 'daemon.token.revoked',
    DAEMON_REGISTERED: 'daemon.registered',
    DAEMON_REVOKED: 'daemon.revoked',
    DAEMON_DELETED: 'daemon.deleted',
    DAEMON_UPGRADE_REQUESTED: 'daemon.upgrade.requested',
    GRANT_MINTED: 'grant.minted',
    GRANT_REVOKED: 'grant.revoked',
    GRANT_REAUTHORIZED: 'grant.reauthorized',
    GRANT_CROSS_AGENT_USE: 'grant.cross_agent_use',
    PERMISSION_REQUESTED: 'permission.requested',
    PERMISSION_GRANTED: 'permission.granted',
    PERMISSION_DENIED: 'permission.denied',
    PERMISSION_REVOKED: 'permission.revoked',
    RUNTIME_TOKEN_ROTATED: 'agent.runtime_token.rotated',
    RUNTIME_TOKEN_ROTATE_FAILED: 'agent.runtime_token.rotate_failed',
    A2A_TASK_STARTED: 'a2a.task.started',
    A2A_TASK_COMPLETED: 'a2a.task.completed',
    A2A_TASK_FAILED: 'a2a.task.failed',
    A2A_TASK_CANCELED: 'a2a.task.canceled',
    A2A_CONNECT_APPROVED: 'a2a.connect.approved'
} as const

// Brand-neutral request header (ADR-0003) a client sets to opt a managed-agent
// runtime identity into account scope — cross-agent / account-level reach.
// Intent only: the API independently verifies the agent_permissions scope and
// intra-user ownership (ADR-0010). Absent / any other value = agent scope.
export const ACCOUNT_SCOPE_HEADER = 'x-account-scope'

// Per-request header carrying the caller's NetMind loginToken (a JWT) to the
// NetMind billing proxy routes. The token is browser-held and forwarded on each
// balance/recharge call; the API re-signs it as `loginToken: Bearer` to NetMind
// and NEVER stores or logs it (mirrors NarraNexus's X-Netmind-Token contract).
export const NETMIND_TOKEN_HEADER = 'x-netmind-token'

export const NETMIND_PROXY_BASE_URL = 'https://3avtktubfdf842bfx2fk.netmind.xyz'

export const OFFICIAL_PROVIDER_BASE_URL = {
    anthropic: 'https://api.anthropic.com',
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    google: 'https://generativelanguage.googleapis.com',
    antigravity: 'https://generativelanguage.googleapis.com',
    antigravity_claude: 'https://api.anthropic.com'
} as const

export const SPRITE_HOME_BASE = '/home/sprite'
export const K8S_HOME_BASE = '/home/node'

export const codingAgentWorkspacePathForHome = (
    homeDir: string,
    agentId: string
): string => `${homeDir}/.manyfold/workspaces/${agentId}`

// Existing agents keep their persisted workspace_path (which may live under
// the legacy `~/.nca` home); derive the enclosing root from the stored path
// instead of recomputing it so renames never strand old workspaces.
export const codingAgentHomeRootForWorkspacePath = (
    workspacePath: string
): string | null => {
    const match = /^(.+)\/workspaces\/[^/]+\/?$/.exec(workspacePath)
    return match ? match[1] : null
}

export const codingAgentWorkspacePath = (
    runtime: AgentRuntime,
    agentId: string,
    homeDir?: string
): string => {
    if (runtime === 'daemon') {
        if (!homeDir)
            throw new Error(
                'codingAgentWorkspacePath: daemon runtime requires homeDir'
            )
        return codingAgentWorkspacePathForHome(homeDir, agentId)
    }
    const home = runtime === 'k8s' ? K8S_HOME_BASE : SPRITE_HOME_BASE
    return codingAgentWorkspacePathForHome(home, agentId)
}

// NarraNexus's BASE_WORKING_PATH defaults to `/data/workspaces` inside the
// container (Dockerfile.manyfold) — K8s mounts a PVC at /data. On sprite the
// container shares the sprite VM's filesystem, so the bootstrap overrides
// BASE_WORKING_PATH to live under sprite $HOME so workspace contents persist
// across suspend/resume.
//
// The per-agent workspace dir follows NarraNexus's own convention:
//   `<BASE_WORKING_PATH>/<agent_id>_<mf_user_id>`
// (see backend/routes/manyfold_files.py and POST /manyfold/agents).
export const NARRANEXUS_K8S_BASE_WORKING_PATH = '/data/workspaces'
export const NARRANEXUS_SPRITE_BASE_WORKING_PATH = `${SPRITE_HOME_BASE}/.narranexus/data/workspaces`

export const narraNexusBaseWorkingPath = (runtime: AgentRuntime): string =>
    runtime === 'sprites'
        ? NARRANEXUS_SPRITE_BASE_WORKING_PATH
        : NARRANEXUS_K8S_BASE_WORKING_PATH
