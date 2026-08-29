export const apiPaths = {
    HEALTH: '/health',
    AUTH_CONFIG: '/auth/config',
    AUTH_SETUP: '/auth/setup',
    AUTH_ME: '/auth/me',
    AUTH_WHOAMI: '/auth/whoami',
    AUTH_CLI_START: '/auth/cli/start',
    AUTH_CLI_APPROVE: '/auth/cli/approve',
    AUTH_CLI_EXCHANGE: '/auth/cli/exchange',
    AUTH_CLI_POLL: '/auth/cli/poll',
    AUTH_CLI_SESSION: (requestId: string, userCode: string) =>
        `/auth/cli/session/${encodeURIComponent(requestId)}/${encodeURIComponent(userCode)}`,
    AUTH_REGISTER: '/auth/register',
    AUTH_LOGIN: '/auth/login',
    AUTH_VERIFY_EMAIL: '/auth/verify-email',
    AUTH_RESEND_CODE: '/auth/resend-code',
    AUTH_LOGOUT: '/auth/logout',
    AUTH_FORGOT_PASSWORD: '/auth/forgot-password',
    AUTH_RESET_PASSWORD: '/auth/reset-password',
    AUTH_OAUTH_GOOGLE_START: '/auth/oauth/google/start',
    AUTH_OAUTH_OIDC_START: '/auth/oauth/oidc/start',
    AUTH_NETMIND: '/auth/netmind',
    CONNECT_A2A_START: '/connect/a2a/start',
    CONNECT_A2A_APPROVE: '/connect/a2a/approve',
    CONNECT_A2A_POLL: '/connect/a2a/poll',
    CONNECT_A2A_DENY: '/connect/a2a/deny',
    CONNECT_A2A_SESSION: (requestId: string, userCode: string) =>
        `/connect/a2a/session/${encodeURIComponent(requestId)}/${encodeURIComponent(userCode)}`,
    AGENTS: '/agents',
    AGENT_BY_ID: (id: string) => `/agents/${id}`,
    AGENT_STOP: (id: string) => `/agents/${id}/stop`,
    AGENT_RESTART: (id: string) => `/agents/${id}/restart`,
    AGENT_SESSIONS: (agentId: string) => `/agents/${agentId}/sessions`,
    AGENT_SESSION_BY_ID: (agentId: string, sessionId: string) =>
        `/agents/${agentId}/sessions/${sessionId}`,
    AGENT_SESSION_MESSAGES: (agentId: string, sessionId: string) =>
        `/agents/${agentId}/sessions/${sessionId}/messages`,
    AGENT_SESSION_MESSAGE_REGENERATE: (
        agentId: string,
        sessionId: string,
        messageId: string
    ) =>
        `/agents/${agentId}/sessions/${sessionId}/messages/${messageId}/regenerate`,
    AGENT_SESSION_STREAM: (agentId: string, sessionId: string) =>
        `/agents/${agentId}/sessions/${sessionId}/stream`,
    AGENT_CHAT_PREWARM: (agentId: string) => `/agents/${agentId}/chat/prewarm`,
    AGENT_SESSION_CANCEL: (agentId: string, sessionId: string) =>
        `/agents/${agentId}/sessions/${sessionId}/cancel`,
    AGENT_SESSION_SHARE: (agentId: string, sessionId: string) =>
        `/agents/${agentId}/sessions/${sessionId}/share`,
    CHAT_SHARED_BY_ID: (shareId: string) =>
        `/chat/shared/${encodeURIComponent(shareId)}`,
    CHAT_SHARED_MESSAGES: (shareId: string) =>
        `/chat/shared/${encodeURIComponent(shareId)}/messages`,
    AGENT_RUNTIME_SESSION_VIEW: (agentId: string) =>
        `/agents/${agentId}/runtime-sessions/view`,
    AGENT_RUNTIME_SESSION_RECOVER_RAW: (agentId: string) =>
        `/agents/${agentId}/runtime-sessions/recover-raw`,
    AGENT_RUNTIME_SESSION_REBUILD_PARSED: (agentId: string) =>
        `/agents/${agentId}/runtime-sessions/rebuild-parsed`,
    AGENT_RUNTIME_SESSION_RESTORE: (agentId: string) =>
        `/agents/${agentId}/runtime-sessions/restore`,
    AGENT_MESSAGES: (agentId: string) => `/agents/${agentId}/messages`,
    AGENT_CONTEXT_DOC: (agentId: string) => `/agents/${agentId}/context-doc`,
    AGENT_CONTEXT_DOC_REFRESH: (agentId: string) =>
        `/agents/${agentId}/context-doc/refresh`,
    AGENT_MODEL_CONFIG: (agentId: string) => `/agents/${agentId}/model-config`,
    AGENT_MODEL_CONFIG_REFRESH_MODELS: (agentId: string) =>
        `/agents/${agentId}/model-config/refresh-models`,
    AGENT_FILES_BASE: (agentId: string) => `/agents/${agentId}/files`,
    AGENT_FILES_ROOTS: (agentId: string) => `/agents/${agentId}/files/roots`,
    AGENT_FILES_LIST: (agentId: string) => `/agents/${agentId}/files/list`,
    AGENT_FILES_STAT: (agentId: string) => `/agents/${agentId}/files/stat`,
    AGENT_FILES_READ: (agentId: string) => `/agents/${agentId}/files/read`,
    AGENT_FILES_WRITE: (agentId: string) => `/agents/${agentId}/files/write`,
    AGENT_FILES_MKDIR: (agentId: string) => `/agents/${agentId}/files/mkdir`,
    AGENT_FILES_MV: (agentId: string) => `/agents/${agentId}/files/mv`,
    AGENT_FILES_RM: (agentId: string) => `/agents/${agentId}/files/rm`,
    AGENT_CHAT_UPLOADS: (agentId: string) => `/agents/${agentId}/chat-uploads`,
    BACKUPS: '/backups',
    BACKUP_BY_ID: (backupId: string) => `/backups/${backupId}`,
    AGENT_BACKUPS: (agentId: string) => `/agents/${agentId}/backups`,
    RESTORE_BY_ID: (restoreId: string) => `/restores/${restoreId}`,
    AGENT_RESTORES: (agentId: string) => `/agents/${agentId}/restores`,
    AGENT_STORAGE_USAGE: (agentId: string) =>
        `/agents/${agentId}/storage-usage`,
    AGENT_FRAMEWORK_VERSION_REFRESH: (id: string) =>
        `/agents/${id}/framework-version/refresh`,
    AGENT_FRAMEWORK_VERSION_UPGRADE: (id: string) =>
        `/agents/${id}/framework-version/upgrade`,
    AGENT_FRAMEWORK_VERSION_UPGRADE_STREAM: (id: string) =>
        `/agents/${id}/framework-version/upgrade-stream`,
    AGENT_MCP_REFRESH: (id: string) => `/agents/${id}/mcp/refresh`,
    AGENT_MCP_MATERIALIZE: (id: string) => `/agents/${id}/mcp/materialize`,
    AGENT_SPRITE_STATUS_STREAM: '/agents/sprite-status/stream',
    SKILLS_INSTALLED: '/skills/installed',
    SKILLS_DISCOVER: '/skills/discover',
    SKILLS_DISCOVER_REFRESH: '/skills/discover/refresh',
    SKILLS_DISCOVER_DETAIL: (skillId: string) =>
        `/skills/discover/${encodeURIComponent(skillId)}`,
    SKILLS_DISCOVER_README: (skillId: string) =>
        `/skills/discover/${encodeURIComponent(skillId)}/readme`,
    SKILLS_INSTALL: '/skills/install',
    SKILLS_INSTALL_BATCH: '/skills/install/batch',
    SKILL_BY_ID: (id: string) => `/skills/${id}`,
    SKILL_REPOS: '/skills/repos',
    SKILL_REPO_BY_ID: (id: string) => `/skills/repos/${id}`,
    SKILLS_LIBRARY: '/skills/library',
    SKILLS_LIBRARY_BY_ID: (id: string) => `/skills/library/${id}`,
    SKILLS_LIBRARY_FILES: (id: string) => `/skills/library/${id}/files`,
    SKILLS_LIBRARY_FILE_BY_ID: (id: string, fileId: string) =>
        `/skills/library/${id}/files/${fileId}`,
    SKILLS_LIBRARY_IMPORT: '/skills/library/import',
    SKILLS_LIBRARY_IMPORT_ARCHIVE: '/skills/library/import/archive',
    SKILLS_LIBRARY_EXPORT: (id: string) => `/skills/library/${id}/export`,
    SKILLS_LIBRARY_PUSH: (id: string) => `/skills/library/${id}/push`,
    SKILLS_LIBRARY_SHARE: (id: string) => `/skills/library/${id}/share`,
    SKILLS_SHARED_BY_ID: (shareId: string) =>
        `/skills/shared/${encodeURIComponent(shareId)}`,
    MCP_CATALOG: '/mcp/catalog',
    MCP_CATALOG_BY_SLUG: (slug: string) =>
        `/mcp/catalog/${encodeURIComponent(slug)}`,
    MCP_LIBRARY: '/mcp/library',
    MCP_LIBRARY_BY_ID: (id: string) => `/mcp/library/${id}`,
    CATALOG_CATEGORIES: '/catalog/categories',
    ADMIN_CATALOG_CATEGORIES: '/admin/catalog-categories',
    ADMIN_CATALOG_CATEGORY_BY_ID: (id: string) =>
        `/admin/catalog-categories/${id}`,
    ADMIN_MCP_CATALOG: '/admin/mcp-catalog',
    ADMIN_MCP_CATALOG_BY_ID: (id: string) => `/admin/mcp-catalog/${id}`,
    ADMIN_SKILLS_CATALOG: '/admin/skills-catalog',
    ADMIN_SKILLS_CATALOG_BY_ID: (skillId: string) =>
        `/admin/skills-catalog/${encodeURIComponent(skillId)}`,
    AUTOMATIONS: '/automations',
    AUTOMATION_BY_ID: (id: string) => `/automations/${id}`,
    AUTOMATION_RUN: (id: string) => `/automations/${id}/run`,
    CHANNELS: '/channels',
    CHANNELS_ACTIVITY: '/channels/activity',
    CHANNEL_LARK_REGISTRATIONS: '/channels/lark-registrations',
    CHANNEL_LARK_REGISTRATION_BY_ID: (id: string) =>
        `/channels/lark-registrations/${id}`,
    CHANNEL_WEIXIN_REGISTRATIONS: '/channels/weixin-registrations',
    CHANNEL_WEIXIN_REGISTRATION_BY_ID: (id: string) =>
        `/channels/weixin-registrations/${id}`,
    CHANNEL_WEIXIN_REGISTRATION_VERIFY_CODE: (id: string) =>
        `/channels/weixin-registrations/${id}/verify-code`,
    CHANNEL_WHATSAPP_REGISTRATIONS: '/channels/whatsapp-registrations',
    CHANNEL_WHATSAPP_REGISTRATION_BY_ID: (id: string) =>
        `/channels/whatsapp-registrations/${id}`,
    CHANNEL_BY_ID: (id: string) => `/channels/${id}`,
    CHANNEL_TEST: (id: string) => `/channels/${id}/test`,
    CHANNEL_REGISTER: (id: string) => `/channels/${id}/register`,
    CHANNEL_DELIVERIES: (id: string) => `/channels/${id}/deliveries`,
    CHANNEL_SLACK_MANIFEST: (id: string) => `/channels/${id}/slack-manifest`,
    CHANNEL_GITHUB_APP_MANIFEST: (id: string) =>
        `/channels/${id}/github-app-manifest`,
    CHANNEL_SCOPES: (id: string) => `/channels/${id}/scopes`,
    CHANNEL_SESSIONS: (id: string) => `/channels/${id}/sessions`,
    CHANNEL_SESSION_BY_ID: (id: string, sessionId: string) =>
        `/channels/${id}/sessions/${sessionId}`,
    AGENT_RUNTIMES: '/agent-runtimes',
    AGENT_RUNTIME_BY_ID: (id: string) => `/agent-runtimes/${id}`,
    AGENT_RUNTIME_AGENTS: (id: string) => `/agent-runtimes/${id}/agents`,
    AGENT_RUNTIME_FRAMEWORK_AGENTS: (id: string) =>
        `/agent-runtimes/${id}/framework-agents`,
    AGENT_RUNTIME_CONTROL_UI: (id: string) =>
        `/agent-runtimes/${id}/control-ui`,
    AGENT_RUNTIME_CONTROL_UI_URL: (id: string) =>
        `/agent-runtimes/${id}/control-ui-url`,
    AGENT_RUNTIME_DASHBOARD: (id: string) => `/agent-runtimes/${id}/dashboard`,
    AGENT_RUNTIME_KEEP_ALIVE: (id: string) =>
        `/agent-runtimes/${id}/keep-alive`,
    AGENT_RUNTIME_RENAME: (id: string) => `/agent-runtimes/${id}/name`,
    SANDBOXES: '/sandboxes',
    SANDBOX_BY_ID: (id: string) => `/sandboxes/${id}`,
    SANDBOX_TERMINAL: (id: string) => `/sandboxes/${id}/terminal`,
    SANDBOX_DETECT_FRAMEWORKS: (id: string) =>
        `/sandboxes/${id}/detect-frameworks`,
    SANDBOX_REFRESH_STATUS: (id: string) => `/sandboxes/${id}/refresh-status`,
    SANDBOX_CLI_UPGRADE: (id: string) => `/sandboxes/${id}/cli/upgrade`,
    SANDBOX_RENAME: (id: string) => `/sandboxes/${id}/name`,
    SANDBOX_SERVICES: (id: string) => `/sandboxes/${id}/services`,
    SANDBOX_SERVICE_BY_NAME: (id: string, name: string) =>
        `/sandboxes/${id}/services/${encodeURIComponent(name)}`,
    SANDBOX_TASKS: (id: string) => `/sandboxes/${id}/tasks`,
    SANDBOX_TASK_BY_NAME: (id: string, name: string) =>
        `/sandboxes/${id}/tasks/${encodeURIComponent(name)}`,
    SANDBOX_STOP: (id: string) => `/sandboxes/${id}/stop`,
    CLI_VERSIONS: '/cli/versions',
    ADMIN_AGENT_RUNTIMES: '/admin/agent-runtimes',
    ADMIN_AGENT_RUNTIME_BY_ID: (id: string) => `/admin/agent-runtimes/${id}`,
    ADMIN_AGENT_RUNTIME_AGENTS: (id: string) =>
        `/admin/agent-runtimes/${id}/agents`,
    ADMIN_AGENT_RUNTIME_FRAMEWORK_AGENTS: (id: string) =>
        `/admin/agent-runtimes/${id}/framework-agents`,
    ADMIN_AGENT_RUNTIME_CONTROL_UI: (id: string) =>
        `/admin/agent-runtimes/${id}/control-ui`,
    ADMIN_AGENT_RUNTIME_CONTROL_UI_URL: (id: string) =>
        `/admin/agent-runtimes/${id}/control-ui-url`,
    ADMIN_AGENT_RUNTIME_DASHBOARD: (id: string) =>
        `/admin/agent-runtimes/${id}/dashboard`,
    ADMIN_AGENT_RUNTIME_KEEP_ALIVE: (id: string) =>
        `/admin/agent-runtimes/${id}/keep-alive`,
    ADMIN_USERS: '/admin/users',
    ADMIN_PLANS: '/admin/plans',
    ADMIN_SETTINGS_LOGIN_PROVIDER: '/admin/settings/login-provider',
    ADMIN_SETTINGS_BUILTIN_SKILL_REPOS: '/admin/settings/builtin-skill-repos',
    ADMIN_SETTINGS_SPRITES_WHOLESALE_CAP:
        '/admin/settings/sprites-wholesale-cap',
    ADMIN_SETTINGS_SPRITES_VENDOR_CAPACITY:
        '/admin/settings/sprites-vendor-capacity',
    ADMIN_SETTINGS_AUTOMATION_RETENTION:
        '/admin/settings/automation-retention',
    ADMIN_SETTINGS_CHAT_EXEC_TIMEOUTS: '/admin/settings/chat-exec-timeouts',
    ADMIN_SETTINGS_A2A_TURN_TIMEOUTS: '/admin/settings/a2a-turn-timeouts',
    ADMIN_SETTINGS_CLI_MINIMUM_VERSION: '/admin/settings/cli-minimum-version',
    ADMIN_SETTINGS_FRAMEWORK_RUNTIME_DEFAULTS:
        '/admin/settings/framework-runtime-defaults',
    ADMIN_SETTINGS_FRAMEWORK_DEFAULT_VERSIONS:
        '/admin/settings/framework-default-versions',
    ADMIN_SETTINGS_FEATURE_TOGGLES: '/admin/settings/feature-toggles',
    ADMIN_BUILT_IN_MODEL_PRICES: '/admin/built-in-model-prices',
    ADMIN_BUILT_IN_MODEL_PRICES_CANDIDATES:
        '/admin/built-in-model-prices/candidates',
    ADMIN_SETTINGS_EMAIL_PROVIDER: '/admin/settings/email-provider',
    ADMIN_SETTINGS_EMAIL_PROVIDER_TEST: '/admin/settings/email-provider/test',
    CONFIG_CLI_MINIMUM_VERSION: '/config/cli-minimum-version',
    CONFIG_CAPABILITIES: '/config/capabilities',
    ADMIN_USER_ROLE: (id: string) => `/admin/users/${id}/role`,
    ADMIN_USER_PLAN: (id: string) => `/admin/users/${id}/plan`,
    ADMIN_USER_FRAMEWORK_RUNTIME_OVERRIDES: (id: string) =>
        `/admin/users/${id}/framework-runtime-overrides`,
    ADMIN_USER_RUNTIME_ACCESS: (id: string) =>
        `/admin/users/${id}/runtime-access`,
    ADMIN_USER_DELETION: (id: string) => `/admin/users/${id}/deletion`,
    ADMIN_USER_DELETION_RESTORE: (id: string) =>
        `/admin/users/${id}/deletion/restore`,
    ADMIN_USER_DELETION_EXECUTE: (id: string) =>
        `/admin/users/${id}/deletion/execute`,
    ADMIN_AGENTS: '/admin/agents',
    ADMIN_AGENT_BY_ID: (id: string) => `/admin/agents/${id}`,
    ADMIN_AGENT_STOP: (id: string) => `/admin/agents/${id}/stop`,
    ADMIN_AGENT_RESTART: (id: string) => `/admin/agents/${id}/restart`,
    ADMIN_SANDBOX_QUOTAS_OVERVIEW: '/admin/sandbox-quotas/overview',
    ADMIN_SANDBOX_QUOTAS_USERS: '/admin/sandbox-quotas/users',
    ADMIN_SANDBOX_QUOTAS_TIMESERIES: '/admin/sandbox-quotas/timeseries',
    ADMIN_AGENT_MODEL_CONFIG: (id: string) =>
        `/admin/agents/${id}/model-config`,
    ADMIN_AGENT_MODEL_CONFIG_REFRESH_MODELS: (id: string) =>
        `/admin/agents/${id}/model-config/refresh-models`,
    ADMIN_AGENT_FILES_ROOTS: (id: string) => `/admin/agents/${id}/files/roots`,
    ADMIN_AGENT_FILES_LIST: (id: string) => `/admin/agents/${id}/files/list`,
    ADMIN_AGENT_FILES_STAT: (id: string) => `/admin/agents/${id}/files/stat`,
    ADMIN_AGENT_FILES_READ: (id: string) => `/admin/agents/${id}/files/read`,
    ADMIN_AGENT_FILES_WRITE: (id: string) => `/admin/agents/${id}/files/write`,
    ADMIN_AGENT_FILES_MKDIR: (id: string) => `/admin/agents/${id}/files/mkdir`,
    ADMIN_AGENT_FILES_MV: (id: string) => `/admin/agents/${id}/files/mv`,
    ADMIN_AGENT_FILES_RM: (id: string) => `/admin/agents/${id}/files/rm`,
    ADMIN_BACKUPS: '/admin/backups',
    ADMIN_BACKUP_BY_ID: (backupId: string) => `/admin/backups/${backupId}`,
    ADMIN_RESTORE_BY_ID: (restoreId: string) => `/admin/restores/${restoreId}`,
    ADMIN_AGENT_BACKUPS: (id: string) => `/admin/agents/${id}/backups`,
    ADMIN_AGENT_RESTORES: (id: string) => `/admin/agents/${id}/restores`,
    ADMIN_AGENT_STORAGE_USAGE: (id: string) =>
        `/admin/agents/${id}/storage-usage`,
    ADMIN_AGENT_FRAMEWORK_VERSION_REFRESH: (id: string) =>
        `/admin/agents/${id}/framework-version/refresh`,
    ADMIN_AGENT_FRAMEWORK_VERSION_UPGRADE: (id: string) =>
        `/admin/agents/${id}/framework-version/upgrade`,
    ADMIN_AGENT_FRAMEWORK_VERSION_UPGRADE_STREAM: (id: string) =>
        `/admin/agents/${id}/framework-version/upgrade-stream`,
    ADMIN_SANDBOXES: '/admin/sandboxes',
    ADMIN_SANDBOX_BY_ID: (id: string) => `/admin/sandboxes/${id}`,
    ADMIN_SANDBOX_TERMINAL: (id: string) => `/admin/sandboxes/${id}/terminal`,
    ADMIN_SANDBOX_DETECT_FRAMEWORKS: (id: string) =>
        `/admin/sandboxes/${id}/detect-frameworks`,
    ADMIN_SANDBOX_REFRESH_STATUS: (id: string) =>
        `/admin/sandboxes/${id}/refresh-status`,
    ADMIN_SANDBOX_CLI_UPGRADE: (id: string) =>
        `/admin/sandboxes/${id}/cli/upgrade`,
    ADMIN_SANDBOX_RENAME: (id: string) => `/admin/sandboxes/${id}/name`,
    ADMIN_SANDBOX_SERVICES: (id: string) => `/admin/sandboxes/${id}/services`,
    ADMIN_SANDBOX_SERVICE_BY_NAME: (id: string, name: string) =>
        `/admin/sandboxes/${id}/services/${encodeURIComponent(name)}`,
    ADMIN_SANDBOX_TASKS: (id: string) => `/admin/sandboxes/${id}/tasks`,
    ADMIN_SANDBOX_TASK_BY_NAME: (id: string, name: string) =>
        `/admin/sandboxes/${id}/tasks/${encodeURIComponent(name)}`,
    ADMIN_SANDBOX_STOP: (id: string) => `/admin/sandboxes/${id}/stop`,
    ADMIN_CHANNELS: '/admin/channels',
    ADMIN_CHANNEL_BY_ID: (id: string) => `/admin/channels/${id}`,
    ADMIN_CHANNEL_TEST: (id: string) => `/admin/channels/${id}/test`,
    ADMIN_CHANNEL_REGISTER: (id: string) => `/admin/channels/${id}/register`,
    USAGE_SUMMARY: '/usage/summary',
    USAGE_TIMESERIES: '/usage/timeseries',
    USAGE_EVENTS: '/usage/events',
    USAGE_SESSIONS: '/usage/sessions',
    USAGE_TOP_AGENTS: '/usage/top-agents',
    ADMIN_USAGE_SUMMARY: '/admin/usage/summary',
    ADMIN_USAGE_TIMESERIES: '/admin/usage/timeseries',
    ADMIN_USAGE_EVENTS: '/admin/usage/events',
    ADMIN_USAGE_SESSIONS: '/admin/usage/sessions',
    ADMIN_USAGE_TOP_USERS: '/admin/usage/top-users',
    ADMIN_USAGE_TOP_AGENTS: '/admin/usage/top-agents',
    ADMIN_CHAT_SESSIONS: '/admin/chat-sessions',
    ADMIN_CHAT_SESSION_BY_ID: (id: string) => `/admin/chat-sessions/${id}`,
    ADMIN_CHAT_SESSION_EVENTS: (id: string) =>
        `/admin/chat-sessions/${id}/events`,
    ADMIN_MODEL_PROVIDERS: '/admin/model-providers',
    ME_MODEL_PROVIDERS: '/me/model-providers',
    ME_CONNECTIONS: '/me/connections',
    ME_CONNECTION_BY_ID: (id: string) => `/me/connections/${id}`,
    ME_CONNECTIONS_GITHUB_START: '/me/connections/github/start',
    ME_CONNECTIONS_CLOUDFLARE: '/me/connections/cloudflare',
    ME_CONNECTIONS_COMPOSIO: '/me/connections/composio',
    ME_CONNECTION_REVEAL: (id: string) => `/me/connections/${id}/reveal`,
    ME_CONNECTION_GITHUB_REPOS: (id: string) =>
        `/me/connections/${id}/github/repos`,
    ME_CONNECTION_CLOUDFLARE_RESOURCES: (id: string) =>
        `/me/connections/${id}/cloudflare/resources`,
    ME_CONNECTION_COMPOSIO_TOOLS: (id: string) =>
        `/me/connections/${id}/composio/tools`,
    CONNECTIONS_GITHUB_CALLBACK: '/connections/github/callback',
    AGENT_SELF_CONNECTIONS: '/agent-self/connections',
    AGENT_SELF_CHANNEL_SEND: (id: string) => `/agent-self/channels/${id}/send`,
    AGENT_SELF_A2A_EXPOSURE: '/agent-self/a2a/exposure',
    AGENT_SELF_A2A_CALLERS: '/agent-self/a2a/callers',
    AGENT_SELF_A2A_CALLER_BY_ID: (tokenId: string) =>
        `/agent-self/a2a/callers/${encodeURIComponent(tokenId)}`,
    ME_RUNTIME_ACCESS: '/me/runtime-access',
    ME_RUNTIME_ACCESS_SANDBOX_USAGE: '/me/runtime-access/sandbox-usage',
    ME_API_TOKENS: '/me/api-tokens',
    ME_API_TOKEN_BY_ID: (id: string) => `/me/api-tokens/${id}`,
    ME_IDENTITIES: '/me/identities',
    ME_IDENTITIES_NETMIND: '/me/identities/netmind',
    ME_IDENTITIES_GOOGLE_START: '/me/identities/google/start',
    ME_PASSWORD: '/me/password',
    ME_PASSWORD_SETUP_START: '/me/password/setup/start',
    ME_EMAIL_CHANGE_START: '/me/email/change/start',
    ME_EMAIL_CHANGE_VERIFY: '/me/email/change/verify',
    ME_PROFILE: '/me/profile',
    ME_AVATAR: '/me/avatar',
    ME_DELETION: '/me/deletion',
    ME_DELETION_CONFIRM: '/me/deletion/confirm',
    ME_DELETION_RESTORE: '/me/deletion/restore',
    ME_IDENTITY_BY_PROVIDER_SUBJECT: (provider: string, subject: string) =>
        `/me/identities/${encodeURIComponent(provider)}/${encodeURIComponent(subject)}`,
    AGENT_GRANTS: (agentId: string) => `/agents/${agentId}/grants`,
    AGENT_PERMISSIONS: (agentId: string) => `/agents/${agentId}/permissions`,
    AGENT_PERMISSIONS_REVOKE: (agentId: string) =>
        `/agents/${agentId}/permissions/revoke`,
    AGENT_PERMISSION_REQUEST: (agentId: string) =>
        `/agents/${agentId}/permissions/request`,
    AGENT_RUNTIME_TOKEN_ROTATE: (agentId: string) =>
        `/agents/${agentId}/runtime-token/rotate`,
    PERMISSION_REQUEST_PREVIEW: '/permission-requests/preview',
    PERMISSION_REQUEST_GRANT: '/permission-requests/grant',
    PERMISSION_REQUEST_DENY: '/permission-requests/deny',
    A2A_EXPOSURE: (agentId: string) => `/a2a/agents/${agentId}/exposure`,
    A2A_GRANTS: (agentId: string) => `/a2a/agents/${agentId}/grants`,
    A2A_GRANTS_BATCH: (agentId: string) =>
        `/a2a/agents/${agentId}/grants/batch`,
    A2A_OUTBOUND_GRANTS: (agentId: string) =>
        `/a2a/agents/${agentId}/outbound-grants`,
    A2A_GRANT_BY_ID: (agentId: string, tokenId: string) =>
        `/a2a/agents/${agentId}/grants/${tokenId}`,
    A2A_TASKS: (agentId: string) => `/a2a/agents/${agentId}/tasks`,
    A2A_AGENT_CARD: (agentId: string) =>
        `/a2a/agents/${agentId}/agent-card.json`,
    ME_MODEL_PROVIDERS_BUILT_IN: '/me/model-providers/built-in',
    ME_MODEL_PROVIDERS_USAGE: '/me/model-providers/usage',
    ME_MODEL_PROVIDERS_NETMIND: '/me/model-providers/netmind',
    ME_MODEL_PROVIDER_BY_ID: (id: string) => `/me/model-providers/${id}`,
    ME_MODEL_PROVIDER_REVEAL: (id: string) =>
        `/me/model-providers/${id}/reveal`,
    ME_MODEL_PROVIDER_TEST: (id: string) => `/me/model-providers/${id}/test`,
    ME_MODEL_PROVIDERS_TEST_INLINE: '/me/model-providers/test',
    ME_MODEL_PROVIDER_MODEL_PRICES: (id: string) =>
        `/me/model-providers/${id}/model-prices`,
    ME_MODEL_PROVIDER_MODEL_PRICES_CANDIDATES: (id: string) =>
        `/me/model-providers/${id}/model-prices/candidates`,
    ME_EXTERNAL_AGENT_PROVIDERS: '/me/external-agent-providers',
    ME_EXTERNAL_AGENT_PROVIDER_BY_ID: (id: string) =>
        `/me/external-agent-providers/${id}`,
    ME_EXTERNAL_AGENT_PROVIDER_REVEAL: (id: string) =>
        `/me/external-agent-providers/${id}/reveal`,
    ME_EXTERNAL_AGENT_PROVIDER_TEST: (id: string) =>
        `/me/external-agent-providers/${id}/test`,
    ME_EXTERNAL_AGENT_PROVIDERS_TEST_INLINE:
        '/me/external-agent-providers/test',
    AGENT_CREDENTIALS: (id: string) => `/agents/${id}/credentials`,
    AGENT_CREDENTIALS_REVEAL: (id: string) =>
        `/agents/${id}/credentials/reveal`,
    DAEMON_REGISTER: '/daemon/register',
    DAEMON_HEARTBEAT: '/daemon/heartbeat',
    DAEMON_ME: '/daemon/me',
    DAEMON_TOKENS: '/daemon/tokens',
    DAEMON_TOKEN_BY_ID: (id: string) => `/daemon/tokens/${id}`,
    DAEMON_HOSTS: '/daemon/hosts',
    DAEMON_HOST_BY_ID: (id: string) => `/daemon/hosts/${id}`,
    DAEMON_HOST_DELETE: (id: string) => `/daemon/hosts/${id}/permanent`,
    DAEMON_HOST_UPGRADE: (id: string) => `/daemon/hosts/${id}/upgrade`,
    DAEMON_HOST_RENAME: (id: string) => `/daemon/hosts/${id}/name`,
    DAEMON_WS: '/daemon/ws',
    ADMIN_DAEMON_HOSTS: '/admin/daemon/hosts',
    ADMIN_DAEMON_HOST_BY_ID: (id: string) => `/admin/daemon/hosts/${id}`,
    ADMIN_DAEMON_HOST_UPGRADE: (id: string) =>
        `/admin/daemon/hosts/${id}/upgrade`,
    FRAMEWORK_CATALOG: (framework: string) => `/framework-catalog/${framework}`,
    ADMIN_FRAMEWORK_CATALOG: (framework: string) =>
        `/admin/framework-catalog/${framework}`,
    ADMIN_FRAMEWORK_CATALOG_MODELS: (framework: string) =>
        `/admin/framework-catalog/${framework}/models`,
    ADMIN_FRAMEWORK_CATALOG_MODEL_BY_ID: (framework: string, id: string) =>
        `/admin/framework-catalog/${framework}/models/${id}`,
    ADMIN_FRAMEWORK_CATALOG_ENUMS: (framework: string) =>
        `/admin/framework-catalog/${framework}/enums`,
    ADMIN_FRAMEWORK_CATALOG_ENUM_BY_ID: (framework: string, id: string) =>
        `/admin/framework-catalog/${framework}/enums/${id}`,
    FRAMEWORK_VERSIONS: '/framework-versions',
    FRAMEWORK_VERSIONS_BY: (framework: string) =>
        `/framework-versions/${framework}`,
    ADMIN_FRAMEWORK_VERSIONS_REFRESH: '/admin/framework-versions/refresh',
    EXPERIMENTS_ME: '/experiments/me',
} as const
