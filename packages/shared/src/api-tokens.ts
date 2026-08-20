export const apiTokenScopes = [
    'api.full',
    'chat.completions',
    'agents:read',
    'agents:edit',
    'agent-runtimes:read',
    'agent-runtimes:edit',
    'sandboxes:read',
    'sandboxes:edit',
    'channels:read',
    'channels:edit',
    'automations:read',
    'automations:edit',
    'chat:read',
    'chat:edit',
    'a2a:read',
    'a2a:edit',
    'model-providers:read',
    'model-providers:edit',
    'model-config:read',
    'model-config:edit',
    'secrets:read',
    'secrets:edit',
    'skills:read',
    'skills:edit',
    'backups:read',
    'backups:edit',
    'terminal:read',
    'terminal:edit',
    'files:read',
    'files:edit',
    'usage:read',
    'byo-providers:read',
    'byo-providers:edit',
    'connections:read',
    'connections:edit'
] as const

export type ApiTokenScope = (typeof apiTokenScopes)[number]

export type GrantableScope = Exclude<
    ApiTokenScope,
    'api.full' | 'chat.completions'
>

export const grantableScopes: readonly GrantableScope[] = apiTokenScopes.filter(
    (s): s is GrantableScope => s !== 'api.full' && s !== 'chat.completions'
)

export interface ScopeMetadata {
    scope: GrantableScope
    resource: string
    operation: 'read' | 'edit'
    summary: string
    danger: 'low' | 'medium' | 'high'
    examples: string[]
    excludes?: string[]
}

export const scopeMetadata: readonly ScopeMetadata[] = [
    {
        scope: 'agents:read',
        resource: 'agents',
        operation: 'read',
        summary: 'List and view your agents.',
        danger: 'low',
        examples: ['list agents', 'inspect agent config']
    },
    {
        scope: 'agents:edit',
        resource: 'agents',
        operation: 'edit',
        summary: 'Create, update, or delete agents.',
        danger: 'high',
        examples: ['rename an agent', 'delete an agent', 'change framework']
    },
    {
        scope: 'agent-runtimes:read',
        resource: 'agent-runtimes',
        operation: 'read',
        summary: 'List runtimes and inspect runtime status.',
        danger: 'low',
        examples: ['view runtime health', 'list available runtimes']
    },
    {
        scope: 'agent-runtimes:edit',
        resource: 'agent-runtimes',
        operation: 'edit',
        summary: 'Provision, restart, or destroy agent runtimes.',
        danger: 'high',
        examples: ['restart sprite', 'recreate runtime', 'change runtime kind']
    },
    {
        scope: 'sandboxes:read',
        resource: 'sandboxes',
        operation: 'read',
        summary: 'List and inspect your standalone sandboxes.',
        danger: 'low',
        examples: ['list sandboxes', 'check sandbox status']
    },
    {
        scope: 'sandboxes:edit',
        resource: 'sandboxes',
        operation: 'edit',
        summary: 'Create or delete sandboxes and toggle their terminal.',
        danger: 'high',
        examples: ['create a sandbox', 'delete a sandbox', 'enable terminal']
    },
    {
        scope: 'channels:read',
        resource: 'channels',
        operation: 'read',
        summary: 'List channel configurations and delivery history.',
        danger: 'low',
        examples: ['inspect Telegram bot config', 'review message deliveries']
    },
    {
        scope: 'channels:edit',
        resource: 'channels',
        operation: 'edit',
        summary: 'Create, update, delete, test, or register channels.',
        danger: 'medium',
        examples: [
            'wire up Lark channel',
            'rotate channel credentials',
            'register a Telegram webhook'
        ]
    },
    {
        scope: 'automations:read',
        resource: 'automations',
        operation: 'read',
        summary: 'List automations and inspect run history.',
        danger: 'low',
        examples: ['view scheduled automations', 'inspect run logs']
    },
    {
        scope: 'automations:edit',
        resource: 'automations',
        operation: 'edit',
        summary: 'Create, update, delete, or trigger automations.',
        danger: 'medium',
        examples: ['schedule a daily run', 'trigger an automation now']
    },
    {
        scope: 'chat:read',
        resource: 'chat',
        operation: 'read',
        summary: 'Read chat sessions and message history.',
        danger: 'medium',
        examples: ['list chat sessions', 'read past conversations']
    },
    {
        scope: 'chat:edit',
        resource: 'chat',
        operation: 'edit',
        summary: 'Send messages and modify chat sessions on your behalf.',
        danger: 'high',
        examples: [
            'post messages as you in a chat',
            'cancel running streams',
            'delete chat sessions'
        ]
    },
    {
        scope: 'a2a:read',
        resource: 'a2a',
        operation: 'read',
        summary:
            'Inspect this agent A2A exposure, callers, peers, and task state.',
        danger: 'low',
        examples: [
            'view A2A exposure and authorized callers',
            'list granted peer agents',
            'get a short-lived bearer to call a granted peer'
        ]
    },
    {
        scope: 'a2a:edit',
        resource: 'a2a',
        operation: 'edit',
        summary:
            'Publish this agent over A2A, manage callers, and invoke peer agents.',
        danger: 'high',
        examples: [
            'enable public A2A exposure',
            'create or revoke an External client token',
            'send an A2A message to a peer agent',
            'track or cancel an A2A task'
        ]
    },
    {
        scope: 'model-providers:read',
        resource: 'model-providers',
        operation: 'read',
        summary: 'List configured model providers (metadata only, no keys).',
        danger: 'low',
        examples: ['view OpenAI provider config', 'list managed credentials']
    },
    {
        scope: 'model-providers:edit',
        resource: 'model-providers',
        operation: 'edit',
        summary:
            'Create, update, delete model providers. Cannot read secret keys.',
        danger: 'high',
        examples: ['add a new provider', 'rotate provider config']
    },
    {
        scope: 'model-config:read',
        resource: 'model-config',
        operation: 'read',
        summary: 'View agent model configuration.',
        danger: 'low',
        examples: ['inspect which model an agent uses']
    },
    {
        scope: 'model-config:edit',
        resource: 'model-config',
        operation: 'edit',
        summary:
            'Change which model an agent runs. May increase or decrease cost.',
        danger: 'high',
        examples: [
            'switch agent to a different model',
            'refresh provider model list'
        ]
    },
    {
        scope: 'secrets:read',
        resource: 'secrets',
        operation: 'read',
        summary:
            'Read agent credentials/secrets in plaintext (API keys, tokens).',
        danger: 'high',
        examples: ['reveal stored OpenAI key', 'read channel credentials']
    },
    {
        scope: 'secrets:edit',
        resource: 'secrets',
        operation: 'edit',
        summary: 'Create, update, or delete agent credentials/secrets.',
        danger: 'high',
        examples: ['rotate stored API key', 'add a new credential']
    },
    {
        scope: 'skills:read',
        resource: 'skills',
        operation: 'read',
        summary: 'List installed skills and discover available skills.',
        danger: 'low',
        examples: ['list installed skills', 'browse skill catalog']
    },
    {
        scope: 'skills:edit',
        resource: 'skills',
        operation: 'edit',
        summary: 'Install, uninstall, enable, or disable skills.',
        danger: 'medium',
        examples: [
            'install a new skill on an agent',
            'disable a skill for an agent'
        ]
    },
    {
        scope: 'backups:read',
        resource: 'backups',
        operation: 'read',
        summary: 'List agent backup snapshots and their metadata.',
        danger: 'medium',
        examples: ['list backups for an agent']
    },
    {
        scope: 'backups:edit',
        resource: 'backups',
        operation: 'edit',
        summary: 'Create new backups or restore an agent from a backup.',
        danger: 'high',
        examples: ['snapshot an agent now', 'restore an agent state']
    },
    {
        scope: 'terminal:read',
        resource: 'terminal',
        operation: 'read',
        summary: 'List active terminal sessions on agent runtimes.',
        danger: 'medium',
        examples: ['list open terminals for an agent']
    },
    {
        scope: 'terminal:edit',
        resource: 'terminal',
        operation: 'edit',
        summary:
            'Open terminals and send input. Equivalent to shell access on agent runtimes.',
        danger: 'high',
        examples: ['exec command in a sprite', 'send keystrokes to a terminal']
    },
    {
        scope: 'files:read',
        resource: 'files',
        operation: 'read',
        summary: 'List, stat, and read files on agent runtimes.',
        danger: 'medium',
        examples: ['list workspace files', 'download a project file']
    },
    {
        scope: 'files:edit',
        resource: 'files',
        operation: 'edit',
        summary:
            'Write, move, delete, or create files on agent runtimes (arbitrary code can result).',
        danger: 'high',
        examples: ['write a new file', 'replace agent config files']
    },
    {
        scope: 'usage:read',
        resource: 'usage',
        operation: 'read',
        summary: 'Read your token / cost usage statistics.',
        danger: 'low',
        examples: ['view usage by agent', 'export usage report']
    },
    {
        scope: 'byo-providers:read',
        resource: 'byo-providers',
        operation: 'read',
        summary:
            'List external agent providers you have brought (Dify, Langflow, etc).',
        danger: 'low',
        examples: ['list configured Dify endpoints']
    },
    {
        scope: 'byo-providers:edit',
        resource: 'byo-providers',
        operation: 'edit',
        summary: 'Add, update, or delete external agent provider configs.',
        danger: 'high',
        examples: ['register a Langflow endpoint', 'rotate Dify credentials']
    },
    {
        scope: 'connections:read',
        resource: 'connections',
        operation: 'read',
        summary:
            'List your linked GitHub and Cloudflare connections (metadata only, no tokens).',
        danger: 'low',
        examples: ['list linked GitHub accounts', 'list Cloudflare accounts']
    },
    {
        scope: 'connections:edit',
        resource: 'connections',
        operation: 'edit',
        summary:
            'Link or remove GitHub/Cloudflare connections that agents inject as credentials.',
        danger: 'high',
        examples: [
            'connect a GitHub account',
            'paste a Cloudflare API token',
            'unlink a connection'
        ]
    }
] as const

export const tokenCreatedViaValues = [
    'cli-poll',
    'user-grant',
    'cli-browser',
    'api'
] as const

export type TokenCreatedVia = (typeof tokenCreatedViaValues)[number]

export const isTokenCreatedVia = (value: unknown): value is TokenCreatedVia =>
    typeof value === 'string' &&
    (tokenCreatedViaValues as readonly string[]).includes(value)

export interface ApiTokenSummary {
    id: string
    name: string
    scopes: ApiTokenScope[]
    lastUsedAt: string | null
    expiresAt: string | null
    revokedAt: string | null
    createdAt: string
    agentId?: string | null
    enforceAgentBinding: boolean
    createdVia: TokenCreatedVia | null
}

export interface CreateApiTokenBody {
    name: string
    scopes: ApiTokenScope[]
    expiresInDays?: number | null
}

export interface CreateApiTokenResponse {
    token: string
    summary: ApiTokenSummary
}

export interface AddAgentGrantBody {
    approvedScopes: GrantableScope[]
    enforceAgentBinding?: boolean
    name?: string
}

export interface AgentGrantMintResponse {
    token: string
    tokenId: string
    agentId: string
    scopes: GrantableScope[]
    expiresAt: string | null
    enforceAgentBinding: boolean
    createdVia: TokenCreatedVia
}

// Agent-initiated incremental permission request (§7.3). The agent holds its
// injected runtime identity and asks for the scope it is missing; approval
// APPENDS to agent_permissions and mints NO bearer (the identity already
// authenticates; verify() re-reads scopes live on the next call).
export interface RequestPermissionBody {
    scopes: GrantableScope[]
}

export interface RequestPermissionResponse {
    consentUrl: string
    scopes: GrantableScope[]
    expiresAt: string
}

export interface PermissionConsentScope {
    scope: GrantableScope
    summary: string
    danger: 'low' | 'medium' | 'high'
}

export type PermissionConsentStatus = 'pending' | 'approved' | 'denied'

// What the owner sees on the consent page. The durable
// permission_consent_requests row supplies the request and resolution fields,
// so a consent surface rebuilt after the fact (chat history, reload, another
// device) renders the decision instead of offering the buttons again.
export interface PermissionConsentPreview {
    agentId: string
    agentName: string
    scopes: PermissionConsentScope[]
    expiresAt: string
    status: PermissionConsentStatus
    approvedScopes: GrantableScope[]
    resolvedAt: string | null
}

export interface GrantPermissionBody {
    token: string
    approvedScopes: GrantableScope[]
}

export interface DenyPermissionBody {
    token: string
}

export interface DenyPermissionResponse {
    agentId: string
    status: PermissionConsentStatus
    resolvedAt: string | null
}

// Owner-direct permission management (Agent detail > Permissions). The owner
// adds or removes capabilities on agent_permissions directly — no bearer is
// minted, the agent's injected runtime identity reads the new scope list live.
export interface ManageAgentPermissionsBody {
    scopes: GrantableScope[]
}

export interface AgentPermissionsResponse {
    agentId: string
    scopes: GrantableScope[]
    updatedAt: string | null
}

export interface RotateRuntimeTokenResponse {
    agentId: string
    runtimeKind: 'sprites' | 'k8s' | 'daemon' | 'external'
    rotatedAt: string
}

export const isApiTokenScope = (value: unknown): value is ApiTokenScope =>
    typeof value === 'string' &&
    (apiTokenScopes as readonly string[]).includes(value)

export const isGrantableScope = (value: unknown): value is GrantableScope =>
    isApiTokenScope(value) &&
    value !== 'api.full' &&
    value !== 'chat.completions'
