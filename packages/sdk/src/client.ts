import {
    ACCOUNT_SCOPE_HEADER,
    CHAT_MESSAGE_SOFT_LIMIT,
    apiPaths
} from '@manyfold/shared'
import { buildApiError } from './errors.js'
import type {
    CapabilitiesResponse,
    A2aExposure,
    A2aGrantBatchResponse,
    A2aGrantMintResponse,
    A2aGrantSummary,
    A2aOutboundGrantSummary,
    A2aTaskTracePage,
    MintA2aGrantBody,
    MintA2aGrantsBody,
    SetExposureBody,
    AddAgentGrantBody,
    AgentPermissionsResponse,
    DenyPermissionResponse,
    GrantPermissionBody,
    PermissionConsentPreview,
    RequestPermissionBody,
    RequestPermissionResponse,
    RotateRuntimeTokenResponse,
    AddRuntimeAgentBody,
    AdminDaemonHostSummary,
    AgentGrantMintResponse,
    ApiTokenSummary,
    UserConnectionSummary,
    CloudflareConnectionResourcesResponse,
    ComposioConnectionToolsResponse,
    CreateCloudflareConnectionBody,
    CreateCloudflareConnectionResult,
    CreateComposioConnectionBody,
    GithubAppManifestResponse,
    GithubConnectionReposResponse,
    GithubConnectionStartResponse,
    RenameConnectionBody,
    AgentSelfConnectionsResponse,
    DaemonHostSummary,
    DaemonTokenSummary,
    IssueDaemonTokenBody,
    IssueDaemonTokenResponse,
    UpgradeDaemonHostResponse,
    AgentBackupRestoreSummary,
    AgentBackupSummary,
    AgentControlUiUrlResponse,
    AgentCredentialsView,
    AgentModelConfigView,
    AgentContextDocStatus,
    AutomationDetail,
    AutomationRunSummary,
    AutomationSummary,
    ChannelDeliverySummary,
    ChannelDetail,
    ChannelScopeSummary,
    ChannelSessionSummary,
    ChannelSummary,
    ChannelTestResult,
    CreateChannelSessionBody,
    LarkAppRegistrationSummary,
    StartLarkRegistrationBody,
    WeixinRegistrationSummary,
    StartWeixinRegistrationBody,
    UpdateChannelSessionBody,
    CliLoginApproveBody,
    CliLoginApproveResponse,
    CliLoginExchangeBody,
    CliLoginExchangeResponse,
    CliLoginPollBody,
    CliLoginPollResponse,
    CliLoginSessionResponse,
    CliLoginStartBody,
    CliLoginStartResponse,
    ConnectA2aApproveBody,
    ConnectA2aApproveResponse,
    ConnectA2aDenyBody,
    ConnectA2aDenyResponse,
    ConnectA2aSessionResponse,
    CreateChannelBody,
    UpdateChannelBody,
    AgentCreateEvent,
    FrameworkUpgradeEvent,
    AgentRuntimeSummary,
    SandboxSummary,
    SandboxServiceSummary,
    SandboxStopResponse,
    SandboxTaskSummary,
    CliVersionCatalog,
    CreateSandboxBody,
    SetSandboxTerminalBody,
    RenameBody,
    AgentSkillsGroup,
    AgentStorageUsageResponse,
    RefreshAgentMcpResponse,
    MaterializeAgentMcpResponse,
    AdminUserModelProviderSummary,
    AgentStopResponse,
    AgentSummary,
    QuotaWarningEvent,
    SandboxQuotasOverview,
    SandboxQuotaTimeseriesRange,
    SandboxQuotaTimeseriesResponse,
    SandboxQuotaUsersPage,
    SpriteHostStatusUpdate,
    SpriteStatusEvent,
    SpriteStatusUpdate,
    ChatMessage,
    ChatMessagesPage,
    ChatSessionSummary,
    ChatUploadResponse,
    CreateAgentBody,
    CreateAgentBackupResponse,
    CreateAutomationBody,
    CreateApiTokenBody,
    CreateApiTokenResponse,
    ConnectNetmindModelProviderBody,
    CreateBuiltInUserModelProviderBody,
    CreateSkillRepoBody,
    CreateMessageRequest,
    CreateSessionRequest,
    RegenerateMessageRequest,
    RegenerateMessageResponse,
    CreateUserModelProviderBody,
    DiscoverableSkillSummary,
    ProviderTestInlineBody,
    ProviderTestResult,
    ManageAgentPermissionsBody,
    RevealAgentCredentialsResponse,
    RestoreAgentBackupBody,
    RefreshAgentModelConfigModelsBody,
    RefreshAgentModelConfigModelsResponse,
    RuntimeAccessSummary,
    SandboxUsageBreakdown,
    ExperimentAssignments,
    UpdateAgentBody,
    UpdateAgentCredentialsBody,
    UpdateAgentModelConfigBody,
    FsListResponse,
    FsOkResponse,
    FsRootsResponse,
    FsStatResponse,
    FrameworkAgentSummary,
    InstallSkillBody,
    InstallSkillBatchBody,
    InstallSkillBatchResult,
    InstalledSkillSummary,
    PushLibrarySkillBody,
    PushLibrarySkillResult,
    CreateLibrarySkillBody,
    UpdateLibrarySkillBody,
    UpsertLibrarySkillFileBody,
    ImportLibrarySkillBody,
    ImportLibrarySkillResult,
    LibrarySkillDetail,
    LibrarySkillImportConflict,
    LibrarySkillSummary,
    ShareLibrarySkillResult,
    GetLibrarySkillShareResult,
    SharedSkillPreview,
    ShareChatSessionResult,
    GetChatSessionShareResult,
    SharedChatSessionPreview,
    SharedChatMessagesPage,
    K8sClusterProbeResult,
    K8sClusterSummary,
    BuiltinSkillReposSettings,
    SpritesVendorCapacityView,
    SpritesWholesaleCapSettings,
    UpdateSpritesWholesaleCapSettingsBody,
    AutomationRetentionSettings,
    UpdateAutomationRetentionSettingsBody,
    ChatExecTimeoutsSettings,
    UpdateChatExecTimeoutsSettingsBody,
    A2aTurnTimeoutsSettings,
    UpdateA2aTurnTimeoutsSettingsBody,
    CliMinimumVersionSettings,
    UpdateCliMinimumVersionSettingsBody,
    McpCatalogEntry,
    McpCatalogPage,
    UserMcpServer,
    CreateUserMcpServerBody,
    UpdateUserMcpServerBody,
    AdminChatSessionDetail,
    AdminChatSessionsPage,
    AdminChatStreamEventsPage,
    AdminMcpCatalogEntry,
    AdminMcpCatalogPage,
    CreateMcpCatalogEntryBody,
    UpdateMcpCatalogEntryBody,
    CatalogCategorySummary,
    CatalogDomain,
    CatalogSort,
    CreateCatalogCategoryBody,
    UpdateCatalogCategoryBody,
    DiscoverableSkillsPage,
    SkillReadmeResponse,
    AdminSkillCatalogItem,
    AdminSkillsCatalogPage,
    UpdateSkillCurationBody,
    FrameworkRuntimeDefaultsSettings,
    UpdateFrameworkRuntimeDefaultsSettingsBody,
    FrameworkDefaultVersionsSettings,
    UpdateFrameworkDefaultVersionsSettingsBody,
    FeatureTogglesView,
    BuiltInModelPriceEntryView,
    BuiltInModelPricesView,
    ModelPriceEntryView,
    ModelPriceSourcesView,
    ProviderModelPricesView,
    UpsertBuiltInModelPriceBody,
    UpsertProviderModelPriceBody,
    UpdateFeatureToggleBody,
    EmailProviderSettings,
    UpdateEmailProviderSettingsBody,
    SendTestEmailBody,
    SendTestEmailResult,
    UserFrameworkRuntimeOverridesSettings,
    UpdateUserFrameworkRuntimeOverridesSettingsBody,
    LoginProviderSettings,
    RevealUserModelProviderResponse,
    RevealConnectionSecretResponse,
    RuntimeSessionRecoverRawResponse,
    RuntimeSessionRebuildParsedResponse,
    SdkSpritesAccountSummary,
    SdkNotificationWebhookSummary,
    CreateNotificationWebhookBody,
    UpdateNotificationWebhookBody,
    SendTestNotificationResult,
    RuntimeSessionRestoreResponse,
    RuntimeSessionViewResponse,
    SkillRepoSummary,
    UpdateSpritesAccountBody,
    UpdateAutomationBody,
    UpdateBuiltinSkillReposSettingsBody,
    UpdateSkillRepoBody,
    UpdateUserSkillBody,
    SdkUserSummary,
    UserDeletionStatusView,
    RequestUserDeletionBody,
    AuthWhoamiResponse,
    AuthSetupBody,
    AuthRegisterBody,
    AuthLoginBody,
    AuthVerifyEmailBody,
    AuthResendCodeBody,
    AuthForgotPasswordBody,
    AuthResetPasswordBody,
    AuthSessionResponse,
    AuthIdentitySummary,
    BindNetmindIdentityBody,
    SetAccountPasswordBody,
    SetAccountPasswordStartResponse,
    ChangeAccountEmailStartBody,
    ChangeAccountEmailStartResponse,
    ChangeAccountEmailVerifyBody,
    UpdateAccountProfileBody,
    AccountProfileSummary,
    NetmindLoginBody,
    AuthRegisterResponse,
    AuthOkResponse,
    PublicAuthConfig,
    UpdateLoginProviderSettingsBody,
    UpdateUserModelProviderBody,
    UpdateUserRuntimeAccessBody,
    UpsertK8sClusterBody,
    UserExternalAgentProviderSummary,
    UserModelProviderSummary,
    UserRole,
    ConfigurableFramework,
    CreateFrameworkEnumBody,
    CreateFrameworkModelBody,
    FrameworkCatalogView,
    FrameworkEnumView,
    FrameworkModelView,
    FrameworkVersionCatalogEntry,
    UpdateFrameworkEnumBody,
    UpdateFrameworkModelBody
} from '@manyfold/shared'
import type { ClientOptions, SdkAgent, SdkUser } from './types.js'
import {
    buildAdminUsageClient,
    buildUsageClient,
    type AdminUsageClient,
    type UsageClient
} from './usage.js'

// A ReadableStream keeps a large upload off the heap; Blob/File is what the
// browser path needs for XHR progress events.
export type FilesWriteBody =
    | Blob
    | ArrayBuffer
    | Uint8Array
    | ReadableStream<Uint8Array>

export interface FilesWriteOptions {
    signal?: AbortSignal
    onProgress?: (loaded: number, total: number) => void
    // declares the body size for a streamed upload
    contentLength?: number
}

export interface AgentCredentialsClient {
    get: (agentId: string) => Promise<AgentCredentialsView>
    reveal: (agentId: string) => Promise<RevealAgentCredentialsResponse>
    update: (
        agentId: string,
        body: UpdateAgentCredentialsBody
    ) => Promise<AgentCredentialsView>
}

export interface AgentPermissionsClient {
    list: (agentId: string) => Promise<AgentPermissionsResponse>
    add: (
        agentId: string,
        body: ManageAgentPermissionsBody
    ) => Promise<AgentPermissionsResponse>
    remove: (
        agentId: string,
        body: ManageAgentPermissionsBody
    ) => Promise<AgentPermissionsResponse>
}

export interface AgentCreateStreamOptions {
    signal?: AbortSignal
    idempotencyKey?: string
}

export interface SpriteStatusStreamHandlers {
    onSnapshot?: (snapshot: SpriteStatusUpdate[]) => void
    onUpdate?: (update: SpriteStatusUpdate) => void
    onHostUpdate?: (update: SpriteHostStatusUpdate) => void
    onQuotaWarning?: (event: QuotaWarningEvent) => void
    onError?: (error: Error) => void
    onOpen?: () => void
    onClose?: () => void
}

export interface SpriteStatusStreamHandle {
    close: () => void
}

export interface AgentsClient {
    list: () => Promise<SdkAgent[]>
    get: (agentId: string) => Promise<AgentSummary>
    create: (body: CreateAgentBody) => Promise<AgentSummary>
    createStream: (
        body: CreateAgentBody,
        onEvent: (event: AgentCreateEvent) => void,
        options?: AgentCreateStreamOptions
    ) => Promise<AgentSummary>
    update: (agentId: string, body: UpdateAgentBody) => Promise<AgentSummary>
    getModelConfig: (agentId: string) => Promise<AgentModelConfigView>
    updateModelConfig: (
        agentId: string,
        body: UpdateAgentModelConfigBody
    ) => Promise<AgentModelConfigView>
    refreshModelConfigModels: (
        agentId: string,
        body?: RefreshAgentModelConfigModelsBody
    ) => Promise<RefreshAgentModelConfigModelsResponse>
    contextDoc: (agentId: string) => Promise<AgentContextDocStatus>
    refreshContextDoc: (agentId: string) => Promise<AgentContextDocStatus>
    delete: (agentId: string) => Promise<void>
    stop: (agentId: string) => Promise<AgentStopResponse>
    restart: (agentId: string) => Promise<AgentSummary>
    storageUsage: (agentId: string) => Promise<AgentStorageUsageResponse>
    refreshFrameworkVersion: (agentId: string) => Promise<AgentSummary>
    refreshMcp: (agentId: string) => Promise<RefreshAgentMcpResponse>
    materializeMcp: (agentId: string) => Promise<MaterializeAgentMcpResponse>
    upgradeFramework: (
        agentId: string,
        targetVersion: string
    ) => Promise<AgentSummary>
    upgradeFrameworkStream: (
        agentId: string,
        targetVersion: string,
        onEvent: (event: FrameworkUpgradeEvent) => void
    ) => Promise<AgentSummary>
    streamSpriteStatus: (
        handlers: SpriteStatusStreamHandlers
    ) => SpriteStatusStreamHandle
    credentials: AgentCredentialsClient
    permissions: AgentPermissionsClient
    addPermission: (
        agentId: string,
        body: AddAgentGrantBody
    ) => Promise<AgentGrantMintResponse>
    requestPermission: (
        agentId: string,
        body: RequestPermissionBody
    ) => Promise<RequestPermissionResponse>
    rotateRuntimeToken: (agentId: string) => Promise<RotateRuntimeTokenResponse>
}

export interface GrantsClient {
    previewRequest: (token: string) => Promise<PermissionConsentPreview>
    grantRequest: (
        body: GrantPermissionBody
    ) => Promise<AgentPermissionsResponse>
    denyRequest: (token: string) => Promise<DenyPermissionResponse>
}

export interface A2aClient {
    getExposure: (agentId: string) => Promise<A2aExposure>
    setExposure: (
        agentId: string,
        body: SetExposureBody
    ) => Promise<A2aExposure>
    mintGrant: (
        agentId: string,
        body: MintA2aGrantBody
    ) => Promise<A2aGrantMintResponse>
    mintGrants: (
        agentId: string,
        body: MintA2aGrantsBody
    ) => Promise<A2aGrantBatchResponse>
    listGrants: (agentId: string) => Promise<A2aGrantSummary[]>
    listOutboundGrants: (agentId: string) => Promise<A2aOutboundGrantSummary[]>
    revokeGrant: (agentId: string, tokenId: string) => Promise<void>
    listTasks: (
        agentId: string,
        params?: { cursor?: string; state?: string }
    ) => Promise<A2aTaskTracePage>
}

interface AgentsPaths {
    base: string
    byId: (id: string) => string
    stop: (id: string) => string
    restart: (id: string) => string
    modelConfig: (id: string) => string
    modelConfigRefreshModels: (id: string) => string
    contextDoc: (id: string) => string
    contextDocRefresh: (id: string) => string
    storageUsage: (id: string) => string
    frameworkVersionRefresh: (id: string) => string
    frameworkVersionUpgrade: (id: string) => string
    frameworkVersionUpgradeStream: (id: string) => string
    mcpRefresh: (id: string) => string
    mcpMaterialize: (id: string) => string
}

interface FilesPaths {
    roots: (id: string) => string
    list: (id: string) => string
    stat: (id: string) => string
    read: (id: string) => string
    write: (id: string) => string
    mkdir: (id: string) => string
    mv: (id: string) => string
    rm: (id: string) => string
}

export interface FilesRootScope {
    rootId?: string
}

export interface AbortableRequestOptions {
    signal?: AbortSignal
}

export interface ListMessagePageOptions extends AbortableRequestOptions {
    limit?: number
    before?: string | null
}

export type FilesRootOptions = AbortableRequestOptions

export interface FilesReadOptions
    extends FilesRootScope, AbortableRequestOptions {}

export interface FilesListOptions
    extends FilesRootScope, AbortableRequestOptions {}

export interface FilesRmOptions extends FilesRootScope {
    recursive?: boolean
}

export interface FilesClient {
    roots: (
        agentId: string,
        opts?: FilesRootOptions
    ) => Promise<FsRootsResponse>
    list: (
        agentId: string,
        path: string,
        opts?: FilesListOptions
    ) => Promise<FsListResponse>
    stat: (
        agentId: string,
        path: string,
        opts?: FilesListOptions
    ) => Promise<FsStatResponse>
    read: (
        agentId: string,
        path: string,
        opts?: FilesReadOptions
    ) => Promise<Response>
    write: (
        agentId: string,
        path: string,
        body: FilesWriteBody,
        opts?: FilesWriteOptions & FilesRootScope
    ) => Promise<FsOkResponse>
    mkdir: (
        agentId: string,
        path: string,
        opts?: FilesRootScope
    ) => Promise<FsOkResponse>
    mv: (
        agentId: string,
        from: string,
        to: string,
        opts?: FilesRootScope
    ) => Promise<FsOkResponse>
    rm: (
        agentId: string,
        path: string,
        opts?: FilesRmOptions
    ) => Promise<FsOkResponse>
}

export interface BackupsListOptions {
    agentId?: string
    userId?: string
}

export interface BackupsClient {
    list: (opts?: BackupsListOptions) => Promise<AgentBackupSummary[]>
    create: (agentId: string) => Promise<CreateAgentBackupResponse>
    delete: (backupId: string) => Promise<void>
    restore: (
        agentId: string,
        body: RestoreAgentBackupBody
    ) => Promise<AgentBackupRestoreSummary>
    getRestore: (restoreId: string) => Promise<AgentBackupRestoreSummary>
}

export interface AgentRuntimesClient {
    list: () => Promise<AgentRuntimeSummary[]>
    get: (id: string) => Promise<AgentRuntimeSummary>
    delete: (id: string) => Promise<void>
    rename: (id: string, name: string) => Promise<AgentRuntimeSummary>
    addAgent: (
        runtimeId: string,
        body: AddRuntimeAgentBody
    ) => Promise<AgentSummary>
    listAgents: (runtimeId: string) => Promise<FrameworkAgentSummary[]>
    removeAgent: (agentId: string) => Promise<void>
    setControlUi: (
        runtimeId: string,
        enabled: boolean
    ) => Promise<AgentRuntimeSummary>
    getControlUiUrl: (
        runtimeId: string,
        agentId?: string,
        opts?: { signal?: AbortSignal }
    ) => Promise<AgentControlUiUrlResponse>
    setDashboard: (
        runtimeId: string,
        enabled: boolean
    ) => Promise<AgentRuntimeSummary>
    setKeepAlive: (
        runtimeId: string,
        enabled: boolean
    ) => Promise<AgentRuntimeSummary>
}

export interface SandboxesClient {
    list: () => Promise<SandboxSummary[]>
    get: (id: string) => Promise<SandboxSummary>
    create: (body: CreateSandboxBody) => Promise<SandboxSummary>
    delete: (id: string) => Promise<void>
    rename: (id: string, name: string) => Promise<SandboxSummary>
    setTerminal: (id: string, enabled: boolean) => Promise<SandboxSummary>
    detectFrameworks: (id: string) => Promise<SandboxSummary>
    refreshStatus: (id: string) => Promise<SandboxSummary>
    upgradeCli: (id: string, targetVersion?: string) => Promise<SandboxSummary>
    listServices: (id: string) => Promise<SandboxServiceSummary[]>
    deleteService: (id: string, name: string) => Promise<void>
    listTasks: (id: string) => Promise<SandboxTaskSummary[]>
    deleteTask: (id: string, name: string) => Promise<void>
    stop: (id: string) => Promise<SandboxStopResponse>
}

export interface CliVersionsClient {
    list: () => Promise<CliVersionCatalog>
}

export interface DaemonsClient {
    listHosts: () => Promise<DaemonHostSummary[]>
    revokeHost: (id: string) => Promise<void>
    deleteHost: (id: string) => Promise<void>
    renameHost: (id: string, name: string) => Promise<DaemonHostSummary>
    upgradeHost: (
        id: string,
        targetVersion?: string
    ) => Promise<UpgradeDaemonHostResponse>
    listTokens: () => Promise<DaemonTokenSummary[]>
    issueToken: (
        body: IssueDaemonTokenBody
    ) => Promise<IssueDaemonTokenResponse>
    revokeToken: (id: string) => Promise<void>
}

export interface ApiTokensClient {
    list: (opts?: {
        agentId?: string
        includeGrants?: boolean
    }) => Promise<ApiTokenSummary[]>
    create: (body: CreateApiTokenBody) => Promise<CreateApiTokenResponse>
    revoke: (id: string) => Promise<void>
}

export interface ModelProvidersClient {
    list: () => Promise<UserModelProviderSummary[]>
    create: (
        body: CreateUserModelProviderBody
    ) => Promise<UserModelProviderSummary>
    createBuiltIn: (
        body: CreateBuiltInUserModelProviderBody
    ) => Promise<UserModelProviderSummary>
    connectNetmind: (
        body: ConnectNetmindModelProviderBody
    ) => Promise<UserModelProviderSummary>
    update: (
        id: string,
        body: UpdateUserModelProviderBody
    ) => Promise<UserModelProviderSummary>
    delete: (id: string) => Promise<void>
    reveal: (id: string) => Promise<RevealUserModelProviderResponse>
    test: (id: string) => Promise<ProviderTestResult>
    testInline: (body: ProviderTestInlineBody) => Promise<ProviderTestResult>
    modelPrices: {
        list: (id: string) => Promise<ProviderModelPricesView>
        candidates: (
            id: string,
            model: string,
            query?: string
        ) => Promise<ModelPriceSourcesView>
        upsert: (
            id: string,
            body: UpsertProviderModelPriceBody
        ) => Promise<ModelPriceEntryView>
        delete: (id: string, model: string) => Promise<void>
    }
}

export interface ConnectionsClient {
    list: () => Promise<UserConnectionSummary[]>
    rename: (
        id: string,
        body: RenameConnectionBody
    ) => Promise<UserConnectionSummary>
    delete: (id: string) => Promise<void>
    githubStart: () => Promise<GithubConnectionStartResponse>
    cloudflareCreate: (
        body: CreateCloudflareConnectionBody
    ) => Promise<CreateCloudflareConnectionResult>
    composioCreate: (
        body: CreateComposioConnectionBody
    ) => Promise<UserConnectionSummary>
    reveal: (id: string) => Promise<RevealConnectionSecretResponse>
    githubRepos: (id: string) => Promise<GithubConnectionReposResponse>
    cloudflareResources: (
        id: string
    ) => Promise<CloudflareConnectionResourcesResponse>
    composioTools: (id: string) => Promise<ComposioConnectionToolsResponse>
}

export interface AgentSelfClient {
    // The calling agent's own linked connections (bound runtime token; no grant).
    connections: () => Promise<AgentSelfConnectionsResponse>
}

export interface IdentitiesClient {
    list: () => Promise<AuthIdentitySummary[]>
    bindNetmind: (
        body: BindNetmindIdentityBody
    ) => Promise<AuthIdentitySummary[]>
    // Returns the Google consent URL for the signed-in link flow; the browser
    // navigates there and lands back on /settings/account with the outcome.
    googleLinkStart: () => Promise<{ url: string }>
    // Mails the first-password setup code to the account's sign-in address;
    // setPassword requires it (as `code`) when no password exists yet.
    setPasswordStart: () => Promise<SetAccountPasswordStartResponse>
    setPassword: (
        body: SetAccountPasswordBody
    ) => Promise<AuthIdentitySummary[]>
    // Atomic change-email: start re-authenticates and mails a code to the new
    // address; verify consumes the code and swaps identity + primary email.
    changeEmailStart: (
        body: ChangeAccountEmailStartBody
    ) => Promise<ChangeAccountEmailStartResponse>
    changeEmailVerify: (
        body: ChangeAccountEmailVerifyBody
    ) => Promise<AuthIdentitySummary[]>
    unlink: (provider: string, subject: string) => Promise<void>
}

export interface ProfileClient {
    update: (body: UpdateAccountProfileBody) => Promise<AccountProfileSummary>
    uploadAvatar: (file: Blob) => Promise<AccountProfileSummary>
    removeAvatar: () => Promise<void>
    // The avatar endpoint needs the bearer token, so a plain <img src> can't
    // load it — fetch the blob and object-URL it instead. null = none set.
    fetchAvatar: () => Promise<Blob | null>
}

export interface SkillsInstalledOptions {
    includeRuntime?: boolean
}

export interface SkillsClient {
    installed: (
        agentId?: string,
        opts?: SkillsInstalledOptions
    ) => Promise<AgentSkillsGroup[]>
    discover: (opts?: {
        agentId?: string
        q?: string
        repoId?: string
    }) => Promise<DiscoverableSkillSummary[]>
    discoverPage: (opts?: {
        agentId?: string
        q?: string
        repoId?: string
        category?: string
        tag?: string
        sort?: CatalogSort
        cursor?: string
        limit?: number
    }) => Promise<DiscoverableSkillsPage>
    detail: (
        skillId: string,
        opts?: { agentId?: string }
    ) => Promise<DiscoverableSkillSummary>
    readme: (skillId: string) => Promise<SkillReadmeResponse>
    refreshDiscover: (opts: {
        agentId?: string
        q?: string
        repoId?: string
    }) => Promise<DiscoverableSkillSummary[]>
    install: (body: InstallSkillBody) => Promise<InstalledSkillSummary>
    installBatch: (
        body: InstallSkillBatchBody
    ) => Promise<InstallSkillBatchResult>
    update: (
        userSkillId: string,
        body: UpdateUserSkillBody
    ) => Promise<InstalledSkillSummary>
    delete: (userSkillId: string) => Promise<void>
    repos: {
        list: () => Promise<SkillRepoSummary[]>
        create: (body: CreateSkillRepoBody) => Promise<SkillRepoSummary>
        update: (
            id: string,
            body: UpdateSkillRepoBody
        ) => Promise<SkillRepoSummary>
        delete: (id: string) => Promise<void>
    }
    library: {
        list: () => Promise<LibrarySkillSummary[]>
        get: (id: string) => Promise<LibrarySkillDetail>
        create: (body: CreateLibrarySkillBody) => Promise<LibrarySkillDetail>
        update: (
            id: string,
            body: UpdateLibrarySkillBody
        ) => Promise<LibrarySkillDetail>
        delete: (id: string, opts?: { force?: boolean }) => Promise<void>
        upsertFile: (
            id: string,
            body: UpsertLibrarySkillFileBody
        ) => Promise<LibrarySkillDetail>
        deleteFile: (id: string, fileId: string) => Promise<LibrarySkillDetail>
        import: (
            body: ImportLibrarySkillBody
        ) => Promise<ImportLibrarySkillResult>
        importArchive: (
            file: Blob,
            filename: string,
            opts?: { onConflict?: LibrarySkillImportConflict }
        ) => Promise<ImportLibrarySkillResult>
        export: (id: string) => Promise<{ blob: Blob; filename: string }>
        push: (
            id: string,
            body?: PushLibrarySkillBody
        ) => Promise<PushLibrarySkillResult>
        share: (id: string) => Promise<ShareLibrarySkillResult>
        revokeShare: (id: string) => Promise<void>
        getShare: (id: string) => Promise<GetLibrarySkillShareResult>
    }
    resolveSharedSkill: (shareId: string) => Promise<SharedSkillPreview>
}

export interface AutomationsClient {
    list: (opts?: { agentId?: string }) => Promise<AutomationSummary[]>
    create: (body: CreateAutomationBody) => Promise<AutomationDetail>
    get: (id: string) => Promise<AutomationDetail>
    update: (
        id: string,
        body: UpdateAutomationBody
    ) => Promise<AutomationDetail>
    run: (id: string) => Promise<AutomationRunSummary>
    delete: (id: string) => Promise<void>
}

export interface ChannelsClient {
    list: () => Promise<ChannelSummary[]>
    create: (body: CreateChannelBody) => Promise<ChannelDetail>
    startLarkRegistration: (
        body: StartLarkRegistrationBody
    ) => Promise<LarkAppRegistrationSummary>
    getLarkRegistration: (id: string) => Promise<LarkAppRegistrationSummary>
    cancelLarkRegistration: (id: string) => Promise<void>
    startWeixinRegistration: (
        body: StartWeixinRegistrationBody
    ) => Promise<WeixinRegistrationSummary>
    getWeixinRegistration: (id: string) => Promise<WeixinRegistrationSummary>
    submitWeixinVerifyCode: (
        id: string,
        verifyCode: string
    ) => Promise<WeixinRegistrationSummary>
    cancelWeixinRegistration: (id: string) => Promise<void>
    get: (id: string) => Promise<ChannelDetail>
    update: (id: string, body: UpdateChannelBody) => Promise<ChannelDetail>
    delete: (id: string) => Promise<void>
    test: (id: string) => Promise<ChannelTestResult>
    register: (id: string) => Promise<ChannelTestResult>
    listDeliveries: (
        id: string,
        opts?: { limit?: number }
    ) => Promise<ChannelDeliverySummary[]>
    slackManifest: (id: string) => Promise<Record<string, unknown>>
    githubAppManifest: (
        id: string,
        opts?: { org?: string }
    ) => Promise<GithubAppManifestResponse>
    listScopes: (id: string) => Promise<ChannelScopeSummary[]>
    listSessions: (
        id: string,
        opts?: { scopeKey?: string; includeArchived?: boolean }
    ) => Promise<ChannelSessionSummary[]>
    createSession: (
        id: string,
        body: CreateChannelSessionBody & { scopeKey: string }
    ) => Promise<ChannelSessionSummary>
    updateSession: (
        id: string,
        sessionId: string,
        body: UpdateChannelSessionBody
    ) => Promise<ChannelSessionSummary>
    deleteSession: (
        id: string,
        sessionId: string,
        opts?: { activateFallback?: boolean }
    ) => Promise<{
        archived: ChannelSessionSummary
        fallbackActivated: ChannelSessionSummary | null
    }>
}

export interface AuthClient {
    config: () => Promise<PublicAuthConfig>
    setup: (body: AuthSetupBody) => Promise<AuthSessionResponse>
    register: (body: AuthRegisterBody) => Promise<AuthRegisterResponse>
    login: (body: AuthLoginBody) => Promise<AuthSessionResponse>
    netmindLogin: (body: NetmindLoginBody) => Promise<AuthSessionResponse>
    verifyEmail: (body: AuthVerifyEmailBody) => Promise<AuthSessionResponse>
    resendCode: (body: AuthResendCodeBody) => Promise<AuthOkResponse>
    logout: () => Promise<AuthOkResponse>
    forgotPassword: (body: AuthForgotPasswordBody) => Promise<AuthOkResponse>
    resetPassword: (body: AuthResetPasswordBody) => Promise<AuthSessionResponse>
    me: () => Promise<SdkUser>
    whoami: () => Promise<AuthWhoamiResponse>
    startCliLogin: (body?: CliLoginStartBody) => Promise<CliLoginStartResponse>
    approveCliLogin: (
        body: CliLoginApproveBody
    ) => Promise<CliLoginApproveResponse>
    exchangeCliLogin: (
        body: CliLoginExchangeBody
    ) => Promise<CliLoginExchangeResponse>
    pollCliLogin: (body: CliLoginPollBody) => Promise<CliLoginPollResponse>
    getCliLoginSession: (
        requestId: string,
        userCode: string
    ) => Promise<CliLoginSessionResponse>
}

export interface ConnectA2aClient {
    getSession: (
        requestId: string,
        userCode: string
    ) => Promise<ConnectA2aSessionResponse>
    approve: (body: ConnectA2aApproveBody) => Promise<ConnectA2aApproveResponse>
    deny: (body: ConnectA2aDenyBody) => Promise<ConnectA2aDenyResponse>
}

export interface FrameworkCatalogClient {
    get: (framework: ConfigurableFramework) => Promise<FrameworkCatalogView>
    createModel: (
        framework: ConfigurableFramework,
        body: CreateFrameworkModelBody
    ) => Promise<FrameworkModelView>
    updateModel: (
        framework: ConfigurableFramework,
        id: string,
        body: UpdateFrameworkModelBody
    ) => Promise<FrameworkModelView>
    deleteModel: (framework: ConfigurableFramework, id: string) => Promise<void>
    createEnum: (
        framework: ConfigurableFramework,
        body: CreateFrameworkEnumBody
    ) => Promise<FrameworkEnumView>
    updateEnum: (
        framework: ConfigurableFramework,
        id: string,
        body: UpdateFrameworkEnumBody
    ) => Promise<FrameworkEnumView>
    deleteEnum: (framework: ConfigurableFramework, id: string) => Promise<void>
}

// Low-level authorized transport, the seam a composition layer's client
// extension builds its extra namespaces on (editions §3.5). `request` is the
// JSON path (error-mapped, GET-deduped); `fetch` is the raw path for blobs
// and status-code-sensitive calls — authorization applied, response returned
// unchecked.
export interface ClientTransport {
    baseUrl: string
    request: <T>(path: string, init?: RequestInit) => Promise<T>
    fetch: (path: string, init?: RequestInit) => Promise<Response>
}

export interface NcaClient {
    transport: ClientTransport
    auth: AuthClient
    runtimeAccess: {
        summary: () => Promise<RuntimeAccessSummary>
        sandboxUsage: () => Promise<SandboxUsageBreakdown>
    }
    agents: AgentsClient
    agentRuntimes: AgentRuntimesClient
    sandboxes: SandboxesClient
    cliVersions: CliVersionsClient
    daemons: DaemonsClient
    apiTokens: ApiTokensClient
    identities: IdentitiesClient
    profile: ProfileClient
    grants: GrantsClient
    a2a: A2aClient
    connectA2a: ConnectA2aClient
    files: FilesClient
    backups: BackupsClient
    usage: UsageClient
    modelProviders: ModelProvidersClient
    connections: ConnectionsClient
    agentSelf: AgentSelfClient
    externalAgentProviders: {
        list: (
            provider?: 'dify' | 'langflow' | 'a2a'
        ) => Promise<UserExternalAgentProviderSummary[]>
        create: (body: {
            provider: 'dify' | 'langflow' | 'a2a'
            label: string
            endpointUrl: string
            apiKey: string
            metadata?: Record<string, unknown>
        }) => Promise<UserExternalAgentProviderSummary>
        update: (
            id: string,
            body: {
                label?: string
                endpointUrl?: string
                apiKey?: string
                metadata?: Record<string, unknown>
            }
        ) => Promise<UserExternalAgentProviderSummary>
        delete: (id: string) => Promise<void>
        test: (id: string) => Promise<{
            ok: boolean
            status: 'ok' | 'error'
            message: string
            models?: string[]
        }>
        testInline: (body: {
            provider: 'dify' | 'langflow' | 'a2a'
            endpointUrl: string
            apiKey: string
        }) => Promise<{
            ok: boolean
            status: 'ok' | 'error'
            message: string
            models?: string[]
        }>
    }
    skills: SkillsClient
    automations: AutomationsClient
    channels: ChannelsClient
    mcp: {
        catalog: (opts?: {
            q?: string
            category?: string
            tag?: string
            sort?: CatalogSort
            cursor?: string
            limit?: number
        }) => Promise<McpCatalogPage>
        catalogEntry: (slug: string) => Promise<McpCatalogEntry>
        library: {
            list: () => Promise<UserMcpServer[]>
            get: (id: string) => Promise<UserMcpServer>
            create: (body: CreateUserMcpServerBody) => Promise<UserMcpServer>
            update: (
                id: string,
                body: UpdateUserMcpServerBody
            ) => Promise<UserMcpServer>
            delete: (id: string) => Promise<void>
        }
    }
    catalogCategories: {
        list: (domain: CatalogDomain) => Promise<CatalogCategorySummary[]>
    }
    config: {
        getCliMinimumVersion: () => Promise<CliMinimumVersionSettings>
        capabilities: () => Promise<CapabilitiesResponse>
    }
    frameworkCatalog: Pick<FrameworkCatalogClient, 'get'>
    frameworkVersions: {
        list: () => Promise<FrameworkVersionCatalogEntry[]>
        get: (framework: string) => Promise<FrameworkVersionCatalogEntry>
    }
    admin: {
        frameworkCatalog: FrameworkCatalogClient
        frameworkVersions: {
            refresh: () => Promise<FrameworkVersionCatalogEntry[]>
        }
        catalogCategories: {
            list: (opts?: {
                domain?: CatalogDomain
            }) => Promise<CatalogCategorySummary[]>
            create: (
                body: CreateCatalogCategoryBody
            ) => Promise<CatalogCategorySummary>
            update: (
                id: string,
                body: UpdateCatalogCategoryBody
            ) => Promise<CatalogCategorySummary>
            delete: (id: string) => Promise<void>
        }
        mcpCatalog: {
            list: (opts?: {
                q?: string
                cursor?: string
                limit?: number
            }) => Promise<AdminMcpCatalogPage>
            get: (id: string) => Promise<AdminMcpCatalogEntry>
            create: (
                body: CreateMcpCatalogEntryBody
            ) => Promise<AdminMcpCatalogEntry>
            update: (
                id: string,
                body: UpdateMcpCatalogEntryBody
            ) => Promise<AdminMcpCatalogEntry>
            delete: (id: string) => Promise<void>
        }
        skillsCatalog: {
            list: (opts?: {
                q?: string
                cursor?: string
                limit?: number
            }) => Promise<AdminSkillsCatalogPage>
            update: (
                skillId: string,
                body: UpdateSkillCurationBody
            ) => Promise<AdminSkillCatalogItem>
        }
        agents: AgentsClient
        agentRuntimes: AgentRuntimesClient
        sandboxes: Pick<
            SandboxesClient,
            | 'list'
            | 'get'
            | 'delete'
            | 'rename'
            | 'setTerminal'
            | 'detectFrameworks'
            | 'refreshStatus'
            | 'upgradeCli'
            | 'listServices'
            | 'deleteService'
            | 'listTasks'
            | 'deleteTask'
            | 'stop'
        >
        channels: Pick<
            ChannelsClient,
            'list' | 'get' | 'update' | 'delete' | 'test' | 'register'
        >
        files: FilesClient
        backups: BackupsClient
        usage: AdminUsageClient
        chatSessions: {
            list: (opts?: {
                agentId?: string
                userId?: string
                status?: 'running'
                hasError?: boolean
                q?: string
                cursor?: string
                limit?: number
            }) => Promise<AdminChatSessionsPage>
            get: (id: string) => Promise<AdminChatSessionDetail>
            listEvents: (
                id: string,
                opts?: {
                    cursor?: string
                    limit?: number
                    order?: 'asc' | 'desc'
                    types?: string[]
                    messageId?: string
                }
            ) => Promise<AdminChatStreamEventsPage>
        }
        daemons: {
            listHosts: () => Promise<AdminDaemonHostSummary[]>
            deleteHost: (id: string) => Promise<void>
            upgradeHost: (
                id: string,
                targetVersion?: string
            ) => Promise<UpgradeDaemonHostResponse>
        }
        modelProviders: {
            list: (opts?: {
                from?: string
                to?: string
            }) => Promise<AdminUserModelProviderSummary[]>
        }
        builtInModelPrices: {
            list: () => Promise<BuiltInModelPricesView>
            candidates: (
                builtInId: string,
                model: string,
                query?: string
            ) => Promise<ModelPriceSourcesView>
            upsert: (
                body: UpsertBuiltInModelPriceBody
            ) => Promise<BuiltInModelPriceEntryView>
            delete: (builtInId: string, model: string) => Promise<void>
        }
        settings: {
            getLoginProvider: () => Promise<LoginProviderSettings>
            updateLoginProvider: (
                body: UpdateLoginProviderSettingsBody
            ) => Promise<LoginProviderSettings>
            getBuiltinSkillRepos: () => Promise<BuiltinSkillReposSettings>
            updateBuiltinSkillRepos: (
                body: UpdateBuiltinSkillReposSettingsBody
            ) => Promise<BuiltinSkillReposSettings>
            getSpritesWholesaleCap: () => Promise<SpritesWholesaleCapSettings>
            updateSpritesWholesaleCap: (
                body: UpdateSpritesWholesaleCapSettingsBody
            ) => Promise<SpritesWholesaleCapSettings>
            getSpritesVendorCapacity: () => Promise<SpritesVendorCapacityView>
            getAutomationRetention: () => Promise<AutomationRetentionSettings>
            updateAutomationRetention: (
                body: UpdateAutomationRetentionSettingsBody
            ) => Promise<AutomationRetentionSettings>
            getChatExecTimeouts: () => Promise<ChatExecTimeoutsSettings>
            updateChatExecTimeouts: (
                body: UpdateChatExecTimeoutsSettingsBody
            ) => Promise<ChatExecTimeoutsSettings>
            getA2aTurnTimeouts: () => Promise<A2aTurnTimeoutsSettings>
            updateA2aTurnTimeouts: (
                body: UpdateA2aTurnTimeoutsSettingsBody
            ) => Promise<A2aTurnTimeoutsSettings>
            getCliMinimumVersion: () => Promise<CliMinimumVersionSettings>
            updateCliMinimumVersion: (
                body: UpdateCliMinimumVersionSettingsBody
            ) => Promise<CliMinimumVersionSettings>
            getFrameworkRuntimeDefaults: () => Promise<FrameworkRuntimeDefaultsSettings>
            updateFrameworkRuntimeDefaults: (
                body: UpdateFrameworkRuntimeDefaultsSettingsBody
            ) => Promise<FrameworkRuntimeDefaultsSettings>
            getFrameworkDefaultVersions: () => Promise<FrameworkDefaultVersionsSettings>
            updateFrameworkDefaultVersions: (
                body: UpdateFrameworkDefaultVersionsSettingsBody
            ) => Promise<FrameworkDefaultVersionsSettings>
            getFeatureToggles: () => Promise<FeatureTogglesView>
            updateFeatureToggle: (
                body: UpdateFeatureToggleBody
            ) => Promise<FeatureTogglesView>
            getEmailProvider: () => Promise<EmailProviderSettings>
            updateEmailProvider: (
                body: UpdateEmailProviderSettingsBody
            ) => Promise<EmailProviderSettings>
            sendTestEmail: (
                body: SendTestEmailBody
            ) => Promise<SendTestEmailResult>
        }
        spritesAccounts: {
            list: () => Promise<SdkSpritesAccountSummary[]>
            get: (slug: string) => Promise<SdkSpritesAccountSummary>
            create: (input: {
                slug: string
                token: string
                notes?: string
                priority?: number
            }) => Promise<SdkSpritesAccountSummary>
            update: (
                slug: string,
                body: UpdateSpritesAccountBody
            ) => Promise<SdkSpritesAccountSummary>
            rotate: (
                slug: string,
                token: string
            ) => Promise<SdkSpritesAccountSummary>
            disable: (slug: string) => Promise<SdkSpritesAccountSummary>
            enable: (slug: string) => Promise<SdkSpritesAccountSummary>
        }
        notificationWebhooks: {
            list: () => Promise<SdkNotificationWebhookSummary[]>
            get: (id: string) => Promise<SdkNotificationWebhookSummary>
            create: (
                body: CreateNotificationWebhookBody
            ) => Promise<SdkNotificationWebhookSummary>
            update: (
                id: string,
                body: UpdateNotificationWebhookBody
            ) => Promise<SdkNotificationWebhookSummary>
            remove: (id: string) => Promise<void>
            test: (id: string) => Promise<SendTestNotificationResult>
        }
        clusters: {
            list: () => Promise<K8sClusterSummary[]>
            get: (id: string) => Promise<K8sClusterSummary>
            create: (body: UpsertK8sClusterBody) => Promise<K8sClusterSummary>
            update: (
                id: string,
                body: UpsertK8sClusterBody
            ) => Promise<K8sClusterSummary>
            delete: (id: string) => Promise<void>
            probe: (id: string) => Promise<K8sClusterProbeResult>
        }
        users: {
            list: () => Promise<SdkUserSummary[]>
            setRole: (id: string, role: UserRole) => Promise<SdkUserSummary>
            setRuntimeAccess: (
                id: string,
                body: UpdateUserRuntimeAccessBody
            ) => Promise<SdkUserSummary>
            getRuntimeAccess: (id: string) => Promise<RuntimeAccessSummary>
            getFrameworkRuntimeOverrides: (
                id: string
            ) => Promise<UserFrameworkRuntimeOverridesSettings>
            setFrameworkRuntimeOverrides: (
                id: string,
                body: UpdateUserFrameworkRuntimeOverridesSettingsBody
            ) => Promise<SdkUserSummary>
            getDeletion: (id: string) => Promise<UserDeletionStatusView | null>
            requestDeletion: (
                id: string,
                body?: RequestUserDeletionBody
            ) => Promise<UserDeletionStatusView>
            restoreDeletion: (id: string) => Promise<UserDeletionStatusView>
            executeDeletion: (
                id: string
            ) => Promise<UserDeletionStatusView | null>
        }
        sandboxQuotas: {
            overview: () => Promise<SandboxQuotasOverview>
            listUsers: (opts?: {
                cursor?: string
                limit?: number
            }) => Promise<SandboxQuotaUsersPage>
            timeseries: (
                range: SandboxQuotaTimeseriesRange
            ) => Promise<SandboxQuotaTimeseriesResponse>
        }
    }
    experiments: {
        me: () => Promise<ExperimentAssignments>
    }
    chat: {
        listSessions: (agentId: string) => Promise<ChatSessionSummary[]>
        createSession: (
            agentId: string,
            body?: CreateSessionRequest
        ) => Promise<ChatSessionSummary>
        updateSession: (
            agentId: string,
            sessionId: string,
            body: { title?: string | null }
        ) => Promise<ChatSessionSummary>
        deleteSession: (
            agentId: string,
            sessionId: string,
            options?: { force?: boolean }
        ) => Promise<void>
        listMessages: (
            agentId: string,
            sessionId: string,
            opts?: AbortableRequestOptions
        ) => Promise<ChatMessage[]>
        listMessagePage: (
            agentId: string,
            sessionId: string,
            opts?: ListMessagePageOptions
        ) => Promise<ChatMessagesPage>
        sendMessage: (
            agentId: string,
            sessionId: string,
            body: Omit<CreateMessageRequest, 'sessionId'>
        ) => Promise<{ userMessage: ChatMessage; assistantMessageId: string }>
        prewarm: (agentId: string) => Promise<{ accepted: boolean }>
        uploadFile: (
            agentId: string,
            file: Blob,
            filename?: string
        ) => Promise<ChatUploadResponse>
        regenerateMessage: (
            agentId: string,
            sessionId: string,
            messageId: string,
            body: RegenerateMessageRequest
        ) => Promise<RegenerateMessageResponse>
        cancelStream: (
            agentId: string,
            sessionId: string,
            assistantMessageId?: string
        ) => Promise<void>
        shareSession: (
            agentId: string,
            sessionId: string
        ) => Promise<ShareChatSessionResult>
        getSessionShare: (
            agentId: string,
            sessionId: string
        ) => Promise<GetChatSessionShareResult>
        revokeSessionShare: (
            agentId: string,
            sessionId: string
        ) => Promise<void>
        resolveShared: (shareId: string) => Promise<SharedChatSessionPreview>
        listSharedMessages: (
            shareId: string,
            opts?: {
                limit?: number
                before?: string
                signal?: AbortSignal
            }
        ) => Promise<SharedChatMessagesPage>
        runtimeSessionView: (
            agentId: string,
            body?: {
                sessionId?: string
                sessionRef?: string
                includeRaw?: boolean
            },
            opts?: { signal?: AbortSignal }
        ) => Promise<RuntimeSessionViewResponse>
        runtimeSessionRecoverRaw: (
            agentId: string,
            body: { sessionId: string; sessionRef: string }
        ) => Promise<RuntimeSessionRecoverRawResponse>
        runtimeSessionRebuildParsed: (
            agentId: string,
            body: { sessionId: string; sessionRef: string }
        ) => Promise<RuntimeSessionRebuildParsedResponse>
        runtimeSessionRestore: (
            agentId: string,
            sessionRef: string
        ) => Promise<RuntimeSessionRestoreResponse>
    }
    health: () => Promise<{ status: string; db: string; version: string }>
}

export type { ClientOptions }

const resolveToken = async (
    token?: string | (() => string | Promise<string>)
): Promise<string | undefined> => {
    if (!token) return undefined
    return typeof token === 'function' ? await token() : token
}

const headersKey = (headers: Headers): string => {
    const entries: Array<[string, string]> = []
    headers.forEach((value, key) => entries.push([key, value]))
    return entries
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}:${value}`)
        .join('\n')
}

interface UploadArgs {
    baseUrl: string
    fetchImpl: typeof fetch
    token?: string | (() => string | Promise<string>)
    accountScope?: boolean
    url: string
    body: FilesWriteBody
    contentLength?: number
    signal?: AbortSignal
    onProgress?: (loaded: number, total: number) => void
}

const isStreamBody = (
    body: FilesWriteBody
): body is ReadableStream<Uint8Array> =>
    typeof ReadableStream !== 'undefined' && body instanceof ReadableStream

const uploadWithProgress = async (args: UploadArgs): Promise<FsOkResponse> => {
    const token = await resolveToken(args.token)
    const streaming = isStreamBody(args.body)
    if (typeof XMLHttpRequest === 'undefined') {
        const headers = new Headers({
            'content-type': 'application/octet-stream'
        })
        if (token) headers.set('authorization', `Bearer ${token}`)
        // a streamed body has no implicit length, so declare it when known —
        // that is what lets the server reject an over-limit upload up front
        if (streaming && args.contentLength !== undefined)
            headers.set('content-length', String(args.contentLength))
        const res = await args.fetchImpl(`${args.baseUrl}${args.url}`, {
            method: 'PUT',
            headers,
            body: args.body as BodyInit,
            signal: args.signal,
            // required by fetch to send a stream body
            ...(streaming ? { duplex: 'half' } : {})
        } as RequestInit)
        if (!res.ok) throw await buildApiError(res)
        const text = await res.text()
        if (!text) return { ok: true }
        try {
            return JSON.parse(text) as FsOkResponse
        } catch {
            return { ok: true }
        }
    }
    if (streaming)
        throw new Error(
            'streaming uploads require a fetch-based runtime; pass a Blob or Uint8Array in the browser'
        )
    return new Promise<FsOkResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', `${args.baseUrl}${args.url}`, true)
        xhr.setRequestHeader('content-type', 'application/octet-stream')
        if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
        if (args.accountScope) xhr.setRequestHeader(ACCOUNT_SCOPE_HEADER, '1')
        xhr.responseType = 'text'
        xhr.upload.onprogress = (ev) => {
            if (args.onProgress && ev.lengthComputable)
                args.onProgress(ev.loaded, ev.total)
        }
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText) as FsOkResponse)
                } catch {
                    resolve({ ok: true })
                }
            } else {
                reject(
                    new Error(
                        `${xhr.status} ${xhr.statusText}: ${xhr.responseText}`
                    )
                )
            }
        }
        xhr.onerror = () => reject(new Error('upload network error'))
        xhr.onabort = () => reject(new Error('upload aborted'))
        if (args.signal) {
            if (args.signal.aborted) {
                xhr.abort()
                return
            }
            args.signal.addEventListener('abort', () => xhr.abort())
        }
        xhr.send(args.body as XMLHttpRequestBodyInit)
    })
}

interface AgentsDeps {
    request: <T>(path: string, init?: RequestInit) => Promise<T>
    fetchImpl: typeof fetch
    baseUrl: string
    token?: string | (() => string | Promise<string>)
    accountScope?: boolean
}

interface SpriteStatusStreamDeps {
    fetchImpl: typeof fetch
    baseUrl: string
    tokenOption?: string | (() => string | Promise<string>)
    signal: AbortSignal
}

const runSpriteStatusStream = async (
    deps: SpriteStatusStreamDeps,
    handlers: SpriteStatusStreamHandlers
): Promise<void> => {
    const { fetchImpl, baseUrl, tokenOption, signal } = deps
    const token = await resolveToken(tokenOption)
    const headers: Record<string, string> = {
        Accept: 'text/event-stream'
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const url = `${baseUrl}${apiPaths.AGENT_SPRITE_STATUS_STREAM}`
    const res = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal
    })
    if (!res.ok || !res.body) {
        throw await buildApiError(res, { prefix: 'SSE' })
    }
    handlers.onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!signal.aborted) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
            dispatchSpriteStatusFrame(buffer.slice(0, boundary), handlers)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
        }
    }
    handlers.onClose?.()
}

const dispatchSpriteStatusFrame = (
    frame: string,
    handlers: SpriteStatusStreamHandlers
): void => {
    const dataLines: string[] = []
    for (const rawLine of frame.split('\n')) {
        const line = rawLine.startsWith(':')
            ? null
            : rawLine.startsWith('data:')
              ? rawLine.slice(5).replace(/^ /, '')
              : null
        if (line !== null) dataLines.push(line)
    }
    if (dataLines.length === 0) return
    let parsed: SpriteStatusEvent
    try {
        parsed = JSON.parse(dataLines.join('\n')) as SpriteStatusEvent
    } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
        return
    }
    if (parsed.type === 'snapshot') handlers.onSnapshot?.(parsed.agents)
    else if (parsed.type === 'update') {
        const { type: _t, ...update } = parsed
        handlers.onUpdate?.(update)
    } else if (parsed.type === 'host-update') {
        const { type: _t, ...update } = parsed
        handlers.onHostUpdate?.(update)
    } else if (parsed.type === 'quota-warning') {
        handlers.onQuotaWarning?.(parsed)
    }
}

const buildAgentsClient = (
    paths: AgentsPaths,
    deps: AgentsDeps
): AgentsClient => {
    const { request, fetchImpl, baseUrl, token: tokenOption } = deps
    return {
        list: () => request<SdkAgent[]>(paths.base),
        get: (agentId) => request<AgentSummary>(paths.byId(agentId)),
        create: (body) =>
            request<AgentSummary>(paths.base, {
                method: 'POST',
                body: JSON.stringify(body)
            }),
        createStream: async (body, onEvent, options) => {
            const token = await resolveToken(tokenOption)
            const headers = new Headers()
            headers.set('Content-Type', 'application/json')
            headers.set('Accept', 'application/x-ndjson')
            if (token) headers.set('Authorization', `Bearer ${token}`)
            if (options?.idempotencyKey)
                headers.set('Idempotency-Key', options.idempotencyKey)
            const res = await fetchImpl(`${baseUrl}${paths.base}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options?.signal
            })
            if (!res.ok || !res.body) {
                throw await buildApiError(res)
            }
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let completed: AgentSummary | null = null
            let errored: { step: string | null; message: string } | null = null
            const dispatch = (line: string): void => {
                if (!line) return
                const event = JSON.parse(line) as AgentCreateEvent
                onEvent(event)
                if (event.type === 'complete') completed = event.agent
                if (event.type === 'error')
                    errored = { step: event.step, message: event.message }
            }
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let nl = buffer.indexOf('\n')
                while (nl !== -1) {
                    dispatch(buffer.slice(0, nl).trim())
                    buffer = buffer.slice(nl + 1)
                    nl = buffer.indexOf('\n')
                }
            }
            if (buffer.trim()) dispatch(buffer.trim())
            if (errored) {
                const err = new Error(
                    (errored as { message: string }).message
                ) as Error & { step: string | null }
                err.step = (errored as { step: string | null }).step
                throw err
            }
            if (!completed)
                throw new Error('stream ended without complete event')
            return completed
        },
        update: (agentId, body) =>
            request<AgentSummary>(paths.byId(agentId), {
                method: 'PATCH',
                body: JSON.stringify(body)
            }),
        getModelConfig: (agentId) =>
            request<AgentModelConfigView>(paths.modelConfig(agentId)),
        updateModelConfig: (agentId, body) =>
            request<AgentModelConfigView>(paths.modelConfig(agentId), {
                method: 'PATCH',
                body: JSON.stringify(body)
            }),
        refreshModelConfigModels: (agentId, body) =>
            request<RefreshAgentModelConfigModelsResponse>(
                paths.modelConfigRefreshModels(agentId),
                {
                    method: 'POST',
                    ...(body ? { body: JSON.stringify(body) } : {})
                }
            ),
        contextDoc: (agentId) =>
            request<AgentContextDocStatus>(paths.contextDoc(agentId)),
        refreshContextDoc: (agentId) =>
            request<AgentContextDocStatus>(paths.contextDocRefresh(agentId), {
                method: 'POST'
            }),
        delete: async (agentId) => {
            const token = await resolveToken(tokenOption)
            const headers = new Headers()
            if (token) headers.set('Authorization', `Bearer ${token}`)
            const res = await fetchImpl(`${baseUrl}${paths.byId(agentId)}`, {
                method: 'DELETE',
                headers
            })
            if (!res.ok && res.status !== 204) {
                throw await buildApiError(res)
            }
        },
        stop: (agentId) =>
            request<AgentStopResponse>(paths.stop(agentId), {
                method: 'POST'
            }),
        restart: (agentId) =>
            request<AgentSummary>(paths.restart(agentId), {
                method: 'POST'
            }),
        storageUsage: (agentId) =>
            request<AgentStorageUsageResponse>(paths.storageUsage(agentId), {
                method: 'POST'
            }),
        refreshFrameworkVersion: (agentId) =>
            request<AgentSummary>(paths.frameworkVersionRefresh(agentId), {
                method: 'POST'
            }),
        refreshMcp: (agentId) =>
            request<RefreshAgentMcpResponse>(paths.mcpRefresh(agentId), {
                method: 'POST'
            }),
        materializeMcp: (agentId) =>
            request<MaterializeAgentMcpResponse>(
                paths.mcpMaterialize(agentId),
                { method: 'POST' }
            ),
        upgradeFramework: (agentId, targetVersion) =>
            request<AgentSummary>(paths.frameworkVersionUpgrade(agentId), {
                method: 'POST',
                body: JSON.stringify({ targetVersion })
            }),
        upgradeFrameworkStream: async (agentId, targetVersion, onEvent) => {
            const token = await resolveToken(tokenOption)
            const headers = new Headers()
            headers.set('Content-Type', 'application/json')
            headers.set('Accept', 'application/x-ndjson')
            if (token) headers.set('Authorization', `Bearer ${token}`)
            const res = await fetchImpl(
                `${baseUrl}${paths.frameworkVersionUpgradeStream(agentId)}`,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ targetVersion })
                }
            )
            if (!res.ok || !res.body) throw await buildApiError(res)
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let completed: AgentSummary | null = null
            let errored: { message: string } | null = null
            const dispatch = (line: string): void => {
                if (!line) return
                const event = JSON.parse(line) as FrameworkUpgradeEvent
                onEvent(event)
                if (event.type === 'complete') completed = event.agent
                if (event.type === 'error') errored = { message: event.message }
            }
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let nl = buffer.indexOf('\n')
                while (nl !== -1) {
                    dispatch(buffer.slice(0, nl).trim())
                    buffer = buffer.slice(nl + 1)
                    nl = buffer.indexOf('\n')
                }
            }
            if (buffer.trim()) dispatch(buffer.trim())
            if (errored)
                throw new Error((errored as { message: string }).message)
            if (!completed)
                throw new Error('stream ended without complete event')
            return completed
        },
        streamSpriteStatus: (handlers) => {
            const controller = new AbortController()
            let closed = false
            const close = (): void => {
                if (closed) return
                closed = true
                controller.abort()
                handlers.onClose?.()
            }
            void runSpriteStatusStream(
                {
                    fetchImpl,
                    baseUrl,
                    tokenOption,
                    signal: controller.signal
                },
                handlers
            ).catch((err) => {
                if (closed) return
                handlers.onError?.(
                    err instanceof Error ? err : new Error(String(err))
                )
            })
            return { close }
        },
        credentials: {
            get: (agentId) =>
                request<AgentCredentialsView>(
                    apiPaths.AGENT_CREDENTIALS(agentId)
                ),
            reveal: (agentId) =>
                request<RevealAgentCredentialsResponse>(
                    apiPaths.AGENT_CREDENTIALS_REVEAL(agentId)
                ),
            update: (agentId, body) =>
                request<AgentCredentialsView>(
                    apiPaths.AGENT_CREDENTIALS(agentId),
                    { method: 'PATCH', body: JSON.stringify(body) }
                )
        },
        permissions: {
            list: (agentId) =>
                request<AgentPermissionsResponse>(
                    apiPaths.AGENT_PERMISSIONS(agentId)
                ),
            add: (agentId, body) =>
                request<AgentPermissionsResponse>(
                    apiPaths.AGENT_PERMISSIONS(agentId),
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            remove: (agentId, body) =>
                request<AgentPermissionsResponse>(
                    apiPaths.AGENT_PERMISSIONS_REVOKE(agentId),
                    { method: 'POST', body: JSON.stringify(body) }
                )
        },
        addPermission: (agentId, body) =>
            request<AgentGrantMintResponse>(apiPaths.AGENT_GRANTS(agentId), {
                method: 'POST',
                body: JSON.stringify(body)
            }),
        requestPermission: (agentId, body) =>
            request<RequestPermissionResponse>(
                apiPaths.AGENT_PERMISSION_REQUEST(agentId),
                { method: 'POST', body: JSON.stringify(body) }
            ),
        rotateRuntimeToken: (agentId) =>
            request<RotateRuntimeTokenResponse>(
                apiPaths.AGENT_RUNTIME_TOKEN_ROTATE(agentId),
                { method: 'POST' }
            )
    }
}

const rootIdQuery = (rootId?: string): string =>
    rootId ? `&rootId=${encodeURIComponent(rootId)}` : ''

const buildFilesClient = (paths: FilesPaths, deps: AgentsDeps): FilesClient => {
    const {
        request,
        fetchImpl,
        baseUrl,
        token: tokenOption,
        accountScope
    } = deps
    return {
        roots: (agentId, opts) =>
            request<FsRootsResponse>(paths.roots(agentId), {
                signal: opts?.signal
            }),
        list: (agentId, path, opts) =>
            request<FsListResponse>(
                `${paths.list(agentId)}?path=${encodeURIComponent(path)}${rootIdQuery(opts?.rootId)}`,
                { signal: opts?.signal }
            ),
        stat: (agentId, path, opts) =>
            request<FsStatResponse>(
                `${paths.stat(agentId)}?path=${encodeURIComponent(path)}${rootIdQuery(opts?.rootId)}`,
                { signal: opts?.signal }
            ),
        read: async (agentId, path, opts) => {
            const token = await resolveToken(tokenOption)
            // marks the request as a raw file-body transfer so transports can
            // exempt it from the short per-request RPC timeout
            const headers = new Headers({ accept: 'application/octet-stream' })
            if (token) headers.set('Authorization', `Bearer ${token}`)
            const url = `${baseUrl}${paths.read(agentId)}?path=${encodeURIComponent(path)}${rootIdQuery(opts?.rootId)}`
            const res = await fetchImpl(url, {
                headers,
                signal: opts?.signal
            })
            if (!res.ok) {
                throw await buildApiError(res)
            }
            return res
        },
        write: (agentId, path, body, opts) =>
            uploadWithProgress({
                baseUrl,
                fetchImpl,
                token: tokenOption,
                accountScope,
                url: `${paths.write(agentId)}?path=${encodeURIComponent(path)}${rootIdQuery(opts?.rootId)}`,
                body,
                contentLength: opts?.contentLength,
                signal: opts?.signal,
                onProgress: opts?.onProgress
            }),
        mkdir: (agentId, path, opts) =>
            request<FsOkResponse>(
                `${paths.mkdir(agentId)}${opts?.rootId ? `?rootId=${encodeURIComponent(opts.rootId)}` : ''}`,
                {
                    method: 'POST',
                    body: JSON.stringify({ path })
                }
            ),
        mv: (agentId, from, to, opts) =>
            request<FsOkResponse>(
                `${paths.mv(agentId)}${opts?.rootId ? `?rootId=${encodeURIComponent(opts.rootId)}` : ''}`,
                {
                    method: 'POST',
                    body: JSON.stringify({ from, to })
                }
            ),
        rm: (agentId, path, opts) => {
            const q = opts?.recursive ? '&recursive=true' : ''
            return request<FsOkResponse>(
                `${paths.rm(agentId)}?path=${encodeURIComponent(path)}${q}${rootIdQuery(opts?.rootId)}`,
                { method: 'DELETE' }
            )
        }
    }
}

const userAgentPaths: AgentsPaths = {
    base: apiPaths.AGENTS,
    byId: apiPaths.AGENT_BY_ID,
    stop: apiPaths.AGENT_STOP,
    restart: apiPaths.AGENT_RESTART,
    modelConfig: apiPaths.AGENT_MODEL_CONFIG,
    modelConfigRefreshModels: apiPaths.AGENT_MODEL_CONFIG_REFRESH_MODELS,
    contextDoc: apiPaths.AGENT_CONTEXT_DOC,
    contextDocRefresh: apiPaths.AGENT_CONTEXT_DOC_REFRESH,
    storageUsage: apiPaths.AGENT_STORAGE_USAGE,
    frameworkVersionRefresh: apiPaths.AGENT_FRAMEWORK_VERSION_REFRESH,
    frameworkVersionUpgrade: apiPaths.AGENT_FRAMEWORK_VERSION_UPGRADE,
    frameworkVersionUpgradeStream:
        apiPaths.AGENT_FRAMEWORK_VERSION_UPGRADE_STREAM,
    mcpRefresh: apiPaths.AGENT_MCP_REFRESH,
    mcpMaterialize: apiPaths.AGENT_MCP_MATERIALIZE
}

const adminAgentPaths: AgentsPaths = {
    base: apiPaths.ADMIN_AGENTS,
    byId: apiPaths.ADMIN_AGENT_BY_ID,
    stop: apiPaths.ADMIN_AGENT_STOP,
    restart: apiPaths.ADMIN_AGENT_RESTART,
    modelConfig: apiPaths.ADMIN_AGENT_MODEL_CONFIG,
    modelConfigRefreshModels: apiPaths.ADMIN_AGENT_MODEL_CONFIG_REFRESH_MODELS,
    // No admin context-doc endpoint; the admin agent UI never calls these.
    contextDoc: apiPaths.AGENT_CONTEXT_DOC,
    contextDocRefresh: apiPaths.AGENT_CONTEXT_DOC_REFRESH,
    storageUsage: apiPaths.ADMIN_AGENT_STORAGE_USAGE,
    frameworkVersionRefresh: apiPaths.ADMIN_AGENT_FRAMEWORK_VERSION_REFRESH,
    frameworkVersionUpgrade: apiPaths.ADMIN_AGENT_FRAMEWORK_VERSION_UPGRADE,
    frameworkVersionUpgradeStream:
        apiPaths.ADMIN_AGENT_FRAMEWORK_VERSION_UPGRADE_STREAM,
    // No admin MCP-refresh endpoint; the admin agent UI never calls this.
    mcpRefresh: apiPaths.AGENT_MCP_REFRESH,
    mcpMaterialize: apiPaths.AGENT_MCP_MATERIALIZE
}

const userFilesPaths: FilesPaths = {
    roots: apiPaths.AGENT_FILES_ROOTS,
    list: apiPaths.AGENT_FILES_LIST,
    stat: apiPaths.AGENT_FILES_STAT,
    read: apiPaths.AGENT_FILES_READ,
    write: apiPaths.AGENT_FILES_WRITE,
    mkdir: apiPaths.AGENT_FILES_MKDIR,
    mv: apiPaths.AGENT_FILES_MV,
    rm: apiPaths.AGENT_FILES_RM
}

const adminFilesPaths: FilesPaths = {
    roots: apiPaths.ADMIN_AGENT_FILES_ROOTS,
    list: apiPaths.ADMIN_AGENT_FILES_LIST,
    stat: apiPaths.ADMIN_AGENT_FILES_STAT,
    read: apiPaths.ADMIN_AGENT_FILES_READ,
    write: apiPaths.ADMIN_AGENT_FILES_WRITE,
    mkdir: apiPaths.ADMIN_AGENT_FILES_MKDIR,
    mv: apiPaths.ADMIN_AGENT_FILES_MV,
    rm: apiPaths.ADMIN_AGENT_FILES_RM
}

export const createClient = (options: ClientOptions): NcaClient => {
    const baseFetch = options.fetch ?? globalThis.fetch
    // Account scope (ADR-0010): when opted in, inject the account-scope header
    // at the transport layer so EVERY fetch path honors it uniformly — the
    // central request(), manual fetch/DELETE helpers, and NDJSON/SSE streams.
    // (The XHR upload path is not fetch-based; it sets the header separately.)
    const fetchImpl: typeof fetch = options.accountScope
        ? (input, init) => {
              const headers = new Headers(init?.headers)
              headers.set(ACCOUNT_SCOPE_HEADER, '1')
              return baseFetch(input, { ...init, headers })
          }
        : baseFetch
    const baseUrl = options.baseUrl.replace(/\/$/, '')
    const inFlightGets = new Map<string, Promise<unknown>>()

    const request = async <T>(
        path: string,
        init: RequestInit = {}
    ): Promise<T> => {
        const token = await resolveToken(options.token)
        const headers = new Headers(init.headers)
        if (init.body != null) headers.set('Content-Type', 'application/json')
        if (token) headers.set('Authorization', `Bearer ${token}`)
        const method = (init.method ?? 'GET').toUpperCase()
        const url = `${baseUrl}${path}`

        const run = async (): Promise<T> => {
            const res = await fetchImpl(url, { ...init, method, headers })
            if (!res.ok) {
                throw await buildApiError(res)
            }
            return res.json() as Promise<T>
        }

        if (method === 'GET' && init.body == null && !init.signal) {
            const key = `${method} ${url}\n${headersKey(headers)}`
            const pending = inFlightGets.get(key)
            if (pending) return pending as Promise<T>
            const promise = run().finally(() => {
                inFlightGets.delete(key)
            })
            inFlightGets.set(key, promise)
            return promise
        }

        return run()
    }

    const deps: AgentsDeps = {
        request,
        fetchImpl,
        baseUrl,
        token: options.token,
        accountScope: options.accountScope
    }

    const deleteNoBody = async (path: string): Promise<void> => {
        const token = await resolveToken(options.token)
        const headers = new Headers()
        if (token) headers.set('Authorization', `Bearer ${token}`)
        const res = await fetchImpl(`${baseUrl}${path}`, {
            method: 'DELETE',
            headers
        })
        if (!res.ok && res.status !== 204) {
            throw await buildApiError(res)
        }
    }

    const buildAgentRuntimesClient = (paths: {
        list: string
        byId: (id: string) => string
        addAgent: (id: string) => string
        listAgents: (id: string) => string
        removeAgent: (agentId: string) => string
        controlUi: (id: string) => string
        controlUiUrl: (id: string) => string
        dashboard: (id: string) => string
        keepAlive: (id: string) => string
        rename: (id: string) => string
    }): AgentRuntimesClient => ({
        list: () => request<AgentRuntimeSummary[]>(paths.list),
        get: (id) => request<AgentRuntimeSummary>(paths.byId(id)),
        rename: (id, name) =>
            request<AgentRuntimeSummary>(paths.rename(id), {
                method: 'PATCH',
                body: JSON.stringify({ name } as RenameBody)
            }),
        delete: async (id) => {
            const token = await resolveToken(options.token)
            const headers = new Headers()
            if (token) headers.set('Authorization', `Bearer ${token}`)
            const res = await fetchImpl(`${baseUrl}${paths.byId(id)}`, {
                method: 'DELETE',
                headers
            })
            if (!res.ok && res.status !== 204) {
                throw await buildApiError(res)
            }
        },
        addAgent: (runtimeId, body) =>
            request<AgentSummary>(paths.addAgent(runtimeId), {
                method: 'POST',
                body: JSON.stringify(body)
            }),
        listAgents: (runtimeId) =>
            request<FrameworkAgentSummary[]>(paths.listAgents(runtimeId)),
        removeAgent: async (agentId) => {
            const token = await resolveToken(options.token)
            const headers = new Headers()
            if (token) headers.set('Authorization', `Bearer ${token}`)
            const res = await fetchImpl(
                `${baseUrl}${paths.removeAgent(agentId)}`,
                { method: 'DELETE', headers }
            )
            if (!res.ok && res.status !== 204) {
                throw await buildApiError(res)
            }
        },
        setControlUi: (runtimeId, enabled) =>
            request<AgentRuntimeSummary>(paths.controlUi(runtimeId), {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            }),
        getControlUiUrl: (runtimeId, agentId, opts) => {
            const base = paths.controlUiUrl(runtimeId)
            const url = agentId
                ? `${base}?agentId=${encodeURIComponent(agentId)}`
                : base
            return request<AgentControlUiUrlResponse>(
                url,
                opts?.signal ? { signal: opts.signal } : undefined
            )
        },
        setDashboard: (runtimeId, enabled) =>
            request<AgentRuntimeSummary>(paths.dashboard(runtimeId), {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            }),
        setKeepAlive: (runtimeId, enabled) =>
            request<AgentRuntimeSummary>(paths.keepAlive(runtimeId), {
                method: 'PATCH',
                body: JSON.stringify({ enabled })
            })
    })

    const buildBackupsClient = (paths: {
        list: string
        byId: (id: string) => string
        create: (agentId: string) => string
        restore: (agentId: string) => string
        restoreById: (id: string) => string
    }): BackupsClient => ({
        list: (opts) => {
            const q = new URLSearchParams()
            if (opts?.agentId) q.set('agentId', opts.agentId)
            if (opts?.userId) q.set('userId', opts.userId)
            const query = q.toString()
            return request<AgentBackupSummary[]>(
                `${paths.list}${query ? `?${query}` : ''}`
            )
        },
        create: (agentId) =>
            request<CreateAgentBackupResponse>(paths.create(agentId), {
                method: 'POST'
            }),
        delete: (backupId) => deleteNoBody(paths.byId(backupId)),
        restore: (agentId, body) =>
            request<AgentBackupRestoreSummary>(paths.restore(agentId), {
                method: 'POST',
                body: JSON.stringify(body)
            }),
        getRestore: (restoreId) =>
            request<AgentBackupRestoreSummary>(paths.restoreById(restoreId))
    })

    const agentRuntimes = buildAgentRuntimesClient({
        list: apiPaths.AGENT_RUNTIMES,
        byId: apiPaths.AGENT_RUNTIME_BY_ID,
        addAgent: apiPaths.AGENT_RUNTIME_AGENTS,
        listAgents: apiPaths.AGENT_RUNTIME_FRAMEWORK_AGENTS,
        removeAgent: apiPaths.AGENT_BY_ID,
        controlUi: apiPaths.AGENT_RUNTIME_CONTROL_UI,
        controlUiUrl: apiPaths.AGENT_RUNTIME_CONTROL_UI_URL,
        dashboard: apiPaths.AGENT_RUNTIME_DASHBOARD,
        keepAlive: apiPaths.AGENT_RUNTIME_KEEP_ALIVE,
        rename: apiPaths.AGENT_RUNTIME_RENAME
    })
    const backups = buildBackupsClient({
        list: apiPaths.BACKUPS,
        byId: apiPaths.BACKUP_BY_ID,
        create: apiPaths.AGENT_BACKUPS,
        restore: apiPaths.AGENT_RESTORES,
        restoreById: apiPaths.RESTORE_BY_ID
    })
    const adminAgentRuntimes = buildAgentRuntimesClient({
        list: apiPaths.ADMIN_AGENT_RUNTIMES,
        byId: apiPaths.ADMIN_AGENT_RUNTIME_BY_ID,
        addAgent: apiPaths.ADMIN_AGENT_RUNTIME_AGENTS,
        listAgents: apiPaths.ADMIN_AGENT_RUNTIME_FRAMEWORK_AGENTS,
        removeAgent: apiPaths.ADMIN_AGENT_BY_ID,
        controlUi: apiPaths.ADMIN_AGENT_RUNTIME_CONTROL_UI,
        controlUiUrl: apiPaths.ADMIN_AGENT_RUNTIME_CONTROL_UI_URL,
        dashboard: apiPaths.ADMIN_AGENT_RUNTIME_DASHBOARD,
        keepAlive: apiPaths.ADMIN_AGENT_RUNTIME_KEEP_ALIVE,
        // no admin rename endpoint either: reuses the user path (ownership-checked)
        rename: apiPaths.AGENT_RUNTIME_RENAME
    })
    const adminBackups = buildBackupsClient({
        list: apiPaths.ADMIN_BACKUPS,
        byId: apiPaths.ADMIN_BACKUP_BY_ID,
        create: apiPaths.ADMIN_AGENT_BACKUPS,
        restore: apiPaths.ADMIN_AGENT_RESTORES,
        restoreById: apiPaths.ADMIN_RESTORE_BY_ID
    })

    const authorizedFetch = async (
        path: string,
        init: RequestInit = {}
    ): Promise<Response> => {
        const token = await resolveToken(options.token)
        const headers = new Headers(init.headers)
        if (token) headers.set('Authorization', `Bearer ${token}`)
        return fetchImpl(`${baseUrl}${path}`, { ...init, headers })
    }

    return {
        transport: { baseUrl, request, fetch: authorizedFetch },
        health: () => request(apiPaths.HEALTH),
        auth: {
            config: () => request<PublicAuthConfig>(apiPaths.AUTH_CONFIG),
            setup: (body) =>
                request<AuthSessionResponse>(apiPaths.AUTH_SETUP, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            register: (body) =>
                request<AuthRegisterResponse>(apiPaths.AUTH_REGISTER, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            login: (body) =>
                request<AuthSessionResponse>(apiPaths.AUTH_LOGIN, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            netmindLogin: (body) =>
                request<AuthSessionResponse>(apiPaths.AUTH_NETMIND, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            verifyEmail: (body) =>
                request<AuthSessionResponse>(apiPaths.AUTH_VERIFY_EMAIL, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            resendCode: (body) =>
                request<AuthOkResponse>(apiPaths.AUTH_RESEND_CODE, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            logout: () =>
                request<AuthOkResponse>(apiPaths.AUTH_LOGOUT, {
                    method: 'POST',
                    body: JSON.stringify({})
                }),
            forgotPassword: (body) =>
                request<AuthOkResponse>(apiPaths.AUTH_FORGOT_PASSWORD, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            resetPassword: (body) =>
                request<AuthSessionResponse>(apiPaths.AUTH_RESET_PASSWORD, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            me: () => request<SdkUser>(apiPaths.AUTH_ME),
            whoami: () => request<AuthWhoamiResponse>(apiPaths.AUTH_WHOAMI),
            startCliLogin: (body = {}) =>
                request<CliLoginStartResponse>(apiPaths.AUTH_CLI_START, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            approveCliLogin: (body) =>
                request<CliLoginApproveResponse>(apiPaths.AUTH_CLI_APPROVE, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            exchangeCliLogin: (body) =>
                request<CliLoginExchangeResponse>(apiPaths.AUTH_CLI_EXCHANGE, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            pollCliLogin: (body) =>
                request<CliLoginPollResponse>(apiPaths.AUTH_CLI_POLL, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            getCliLoginSession: (requestId, userCode) =>
                request<CliLoginSessionResponse>(
                    apiPaths.AUTH_CLI_SESSION(requestId, userCode)
                )
        },
        connectA2a: {
            getSession: (requestId, userCode) =>
                request<ConnectA2aSessionResponse>(
                    apiPaths.CONNECT_A2A_SESSION(requestId, userCode)
                ),
            approve: (body) =>
                request<ConnectA2aApproveResponse>(
                    apiPaths.CONNECT_A2A_APPROVE,
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            deny: (body) =>
                request<ConnectA2aDenyResponse>(apiPaths.CONNECT_A2A_DENY, {
                    method: 'POST',
                    body: JSON.stringify(body)
                })
        },
        runtimeAccess: {
            summary: () =>
                request<RuntimeAccessSummary>(apiPaths.ME_RUNTIME_ACCESS),
            sandboxUsage: () =>
                request<SandboxUsageBreakdown>(
                    apiPaths.ME_RUNTIME_ACCESS_SANDBOX_USAGE
                )
        },
        agents: buildAgentsClient(userAgentPaths, deps),
        agentRuntimes,
        sandboxes: {
            list: () => request<SandboxSummary[]>(apiPaths.SANDBOXES),
            get: (id) => request<SandboxSummary>(apiPaths.SANDBOX_BY_ID(id)),
            create: (body) =>
                request<SandboxSummary>(apiPaths.SANDBOXES, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            delete: (id) => deleteNoBody(apiPaths.SANDBOX_BY_ID(id)),
            rename: (id, name) =>
                request<SandboxSummary>(apiPaths.SANDBOX_RENAME(id), {
                    method: 'PATCH',
                    body: JSON.stringify({ name } as RenameBody)
                }),
            setTerminal: (id, enabled) =>
                request<SandboxSummary>(apiPaths.SANDBOX_TERMINAL(id), {
                    method: 'PATCH',
                    body: JSON.stringify({ enabled } as SetSandboxTerminalBody)
                }),
            detectFrameworks: (id) =>
                request<SandboxSummary>(
                    apiPaths.SANDBOX_DETECT_FRAMEWORKS(id),
                    { method: 'POST' }
                ),
            refreshStatus: (id) =>
                request<SandboxSummary>(apiPaths.SANDBOX_REFRESH_STATUS(id), {
                    method: 'POST'
                }),
            upgradeCli: (id, targetVersion) =>
                request<SandboxSummary>(apiPaths.SANDBOX_CLI_UPGRADE(id), {
                    method: 'POST',
                    body: JSON.stringify({ targetVersion })
                }),
            listServices: (id) =>
                request<SandboxServiceSummary[]>(apiPaths.SANDBOX_SERVICES(id)),
            deleteService: (id, name) =>
                deleteNoBody(apiPaths.SANDBOX_SERVICE_BY_NAME(id, name)),
            listTasks: (id) =>
                request<SandboxTaskSummary[]>(apiPaths.SANDBOX_TASKS(id)),
            deleteTask: (id, name) =>
                deleteNoBody(apiPaths.SANDBOX_TASK_BY_NAME(id, name)),
            stop: (id) =>
                request<SandboxStopResponse>(apiPaths.SANDBOX_STOP(id), {
                    method: 'POST'
                })
        },
        cliVersions: {
            list: () => request<CliVersionCatalog>(apiPaths.CLI_VERSIONS)
        },
        daemons: {
            listHosts: () =>
                request<DaemonHostSummary[]>(apiPaths.DAEMON_HOSTS),
            revokeHost: (id) => deleteNoBody(apiPaths.DAEMON_HOST_BY_ID(id)),
            deleteHost: (id) => deleteNoBody(apiPaths.DAEMON_HOST_DELETE(id)),
            renameHost: (id, name) =>
                request<DaemonHostSummary>(apiPaths.DAEMON_HOST_RENAME(id), {
                    method: 'PATCH',
                    body: JSON.stringify({ name } as RenameBody)
                }),
            upgradeHost: (id, targetVersion) =>
                request<UpgradeDaemonHostResponse>(
                    apiPaths.DAEMON_HOST_UPGRADE(id),
                    { method: 'POST', body: JSON.stringify({ targetVersion }) }
                ),
            listTokens: () =>
                request<DaemonTokenSummary[]>(apiPaths.DAEMON_TOKENS),
            issueToken: (body) =>
                request<IssueDaemonTokenResponse>(apiPaths.DAEMON_TOKENS, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            revokeToken: (id) => deleteNoBody(apiPaths.DAEMON_TOKEN_BY_ID(id))
        },
        apiTokens: {
            list: (opts) => {
                const q = new URLSearchParams()
                if (opts?.agentId) q.set('agentId', opts.agentId)
                else if (opts?.includeGrants) q.set('includeGrants', 'true')
                const query = q.toString()
                return request<ApiTokenSummary[]>(
                    `${apiPaths.ME_API_TOKENS}${query ? `?${query}` : ''}`
                )
            },
            create: (body) =>
                request<CreateApiTokenResponse>(apiPaths.ME_API_TOKENS, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            revoke: (id) => deleteNoBody(apiPaths.ME_API_TOKEN_BY_ID(id))
        },
        grants: {
            previewRequest: (token) =>
                request<PermissionConsentPreview>(
                    apiPaths.PERMISSION_REQUEST_PREVIEW,
                    { method: 'POST', body: JSON.stringify({ token }) }
                ),
            grantRequest: (body) =>
                request<AgentPermissionsResponse>(
                    apiPaths.PERMISSION_REQUEST_GRANT,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            denyRequest: (token) =>
                request<DenyPermissionResponse>(
                    apiPaths.PERMISSION_REQUEST_DENY,
                    { method: 'POST', body: JSON.stringify({ token }) }
                )
        },
        a2a: {
            getExposure: (agentId) =>
                request<A2aExposure>(apiPaths.A2A_EXPOSURE(agentId)),
            setExposure: (agentId, body) =>
                request<A2aExposure>(apiPaths.A2A_EXPOSURE(agentId), {
                    method: 'PUT',
                    body: JSON.stringify(body)
                }),
            mintGrant: (agentId, body) =>
                request<A2aGrantMintResponse>(apiPaths.A2A_GRANTS(agentId), {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            mintGrants: (agentId, body) =>
                request<A2aGrantBatchResponse>(
                    apiPaths.A2A_GRANTS_BATCH(agentId),
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            listGrants: (agentId) =>
                request<A2aGrantSummary[]>(apiPaths.A2A_GRANTS(agentId)),
            listOutboundGrants: (agentId) =>
                request<A2aOutboundGrantSummary[]>(
                    apiPaths.A2A_OUTBOUND_GRANTS(agentId)
                ),
            revokeGrant: (agentId, tokenId) =>
                deleteNoBody(apiPaths.A2A_GRANT_BY_ID(agentId, tokenId)),
            listTasks: (agentId, params) => {
                const q = new URLSearchParams()
                if (params?.cursor) q.set('cursor', params.cursor)
                if (params?.state) q.set('state', params.state)
                const suffix = q.toString() ? `?${q.toString()}` : ''
                return request<A2aTaskTracePage>(
                    `${apiPaths.A2A_TASKS(agentId)}${suffix}`
                )
            }
        },
        files: buildFilesClient(userFilesPaths, deps),
        backups,
        usage: buildUsageClient(request),
        modelProviders: {
            list: () =>
                request<UserModelProviderSummary[]>(
                    apiPaths.ME_MODEL_PROVIDERS
                ),
            create: (body) =>
                request<UserModelProviderSummary>(apiPaths.ME_MODEL_PROVIDERS, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            createBuiltIn: (body) =>
                request<UserModelProviderSummary>(
                    apiPaths.ME_MODEL_PROVIDERS_BUILT_IN,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            connectNetmind: (body) =>
                request<UserModelProviderSummary>(
                    apiPaths.ME_MODEL_PROVIDERS_NETMIND,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            update: (id, body) =>
                request<UserModelProviderSummary>(
                    apiPaths.ME_MODEL_PROVIDER_BY_ID(id),
                    { method: 'PATCH', body: JSON.stringify(body) }
                ),
            delete: async (id) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.ME_MODEL_PROVIDER_BY_ID(id)}`,
                    { method: 'DELETE', headers }
                )
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            reveal: (id) =>
                request<RevealUserModelProviderResponse>(
                    apiPaths.ME_MODEL_PROVIDER_REVEAL(id)
                ),
            test: (id) =>
                request<ProviderTestResult>(
                    apiPaths.ME_MODEL_PROVIDER_TEST(id),
                    { method: 'POST' }
                ),
            testInline: (body) =>
                request<ProviderTestResult>(
                    apiPaths.ME_MODEL_PROVIDERS_TEST_INLINE,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            modelPrices: {
                list: (id) =>
                    request<ProviderModelPricesView>(
                        apiPaths.ME_MODEL_PROVIDER_MODEL_PRICES(id)
                    ),
                candidates: (id, model, query) => {
                    const parts = [`model=${encodeURIComponent(model)}`]
                    if (query) parts.push(`q=${encodeURIComponent(query)}`)
                    return request<ModelPriceSourcesView>(
                        `${apiPaths.ME_MODEL_PROVIDER_MODEL_PRICES_CANDIDATES(id)}?${parts.join('&')}`
                    )
                },
                upsert: (id, body) =>
                    request<ModelPriceEntryView>(
                        apiPaths.ME_MODEL_PROVIDER_MODEL_PRICES(id),
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                delete: (id, model) =>
                    request<void>(
                        `${apiPaths.ME_MODEL_PROVIDER_MODEL_PRICES(id)}?model=${encodeURIComponent(model)}`,
                        { method: 'DELETE' }
                    )
            }
        },
        identities: {
            list: () => request<AuthIdentitySummary[]>(apiPaths.ME_IDENTITIES),
            bindNetmind: (body) =>
                request<AuthIdentitySummary[]>(apiPaths.ME_IDENTITIES_NETMIND, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            googleLinkStart: () =>
                request<{ url: string }>(apiPaths.ME_IDENTITIES_GOOGLE_START, {
                    method: 'POST'
                }),
            setPasswordStart: () =>
                request<SetAccountPasswordStartResponse>(
                    apiPaths.ME_PASSWORD_SETUP_START,
                    { method: 'POST' }
                ),
            setPassword: (body) =>
                request<AuthIdentitySummary[]>(apiPaths.ME_PASSWORD, {
                    method: 'PUT',
                    body: JSON.stringify(body)
                }),
            changeEmailStart: (body) =>
                request<ChangeAccountEmailStartResponse>(
                    apiPaths.ME_EMAIL_CHANGE_START,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            changeEmailVerify: (body) =>
                request<AuthIdentitySummary[]>(
                    apiPaths.ME_EMAIL_CHANGE_VERIFY,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            unlink: async (provider, subject) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.ME_IDENTITY_BY_PROVIDER_SUBJECT(
                        provider,
                        subject
                    )}`,
                    { method: 'DELETE', headers }
                )
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            }
        },
        profile: {
            update: (body) =>
                request<AccountProfileSummary>(apiPaths.ME_PROFILE, {
                    method: 'PATCH',
                    body: JSON.stringify(body)
                }),
            // FormData sets its own multipart boundary — the shared request()
            // helper would force JSON headers, so this goes through raw fetch.
            uploadAvatar: async (file) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const form = new FormData()
                form.append('file', file, 'avatar')
                const res = await fetchImpl(`${baseUrl}${apiPaths.ME_AVATAR}`, {
                    method: 'PUT',
                    headers,
                    body: form
                })
                if (!res.ok) throw await buildApiError(res)
                return (await res.json()) as AccountProfileSummary
            },
            removeAvatar: async () => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(`${baseUrl}${apiPaths.ME_AVATAR}`, {
                    method: 'DELETE',
                    headers
                })
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            fetchAvatar: async () => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(`${baseUrl}${apiPaths.ME_AVATAR}`, {
                    headers
                })
                if (res.status === 404) return null
                if (!res.ok) throw await buildApiError(res)
                return res.blob()
            }
        },
        connections: {
            list: () =>
                request<UserConnectionSummary[]>(apiPaths.ME_CONNECTIONS),
            rename: (id, body) =>
                request<UserConnectionSummary>(
                    apiPaths.ME_CONNECTION_BY_ID(id),
                    { method: 'PATCH', body: JSON.stringify(body) }
                ),
            delete: async (id) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.ME_CONNECTION_BY_ID(id)}`,
                    { method: 'DELETE', headers }
                )
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            githubStart: () =>
                request<GithubConnectionStartResponse>(
                    apiPaths.ME_CONNECTIONS_GITHUB_START,
                    { method: 'POST' }
                ),
            cloudflareCreate: (body) =>
                request<CreateCloudflareConnectionResult>(
                    apiPaths.ME_CONNECTIONS_CLOUDFLARE,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            composioCreate: (body) =>
                request<UserConnectionSummary>(
                    apiPaths.ME_CONNECTIONS_COMPOSIO,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            reveal: (id) =>
                request<RevealConnectionSecretResponse>(
                    apiPaths.ME_CONNECTION_REVEAL(id)
                ),
            githubRepos: (id) =>
                request<GithubConnectionReposResponse>(
                    apiPaths.ME_CONNECTION_GITHUB_REPOS(id)
                ),
            cloudflareResources: (id) =>
                request<CloudflareConnectionResourcesResponse>(
                    apiPaths.ME_CONNECTION_CLOUDFLARE_RESOURCES(id)
                ),
            composioTools: (id) =>
                request<ComposioConnectionToolsResponse>(
                    apiPaths.ME_CONNECTION_COMPOSIO_TOOLS(id)
                )
        },
        agentSelf: {
            connections: () =>
                request<AgentSelfConnectionsResponse>(
                    apiPaths.AGENT_SELF_CONNECTIONS
                )
        },
        externalAgentProviders: {
            list: (provider) => {
                const q = provider ? `?provider=${provider}` : ''
                return request<UserExternalAgentProviderSummary[]>(
                    `${apiPaths.ME_EXTERNAL_AGENT_PROVIDERS}${q}`
                )
            },
            create: (body) =>
                request<UserExternalAgentProviderSummary>(
                    apiPaths.ME_EXTERNAL_AGENT_PROVIDERS,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            update: (id, body) =>
                request<UserExternalAgentProviderSummary>(
                    apiPaths.ME_EXTERNAL_AGENT_PROVIDER_BY_ID(id),
                    { method: 'PATCH', body: JSON.stringify(body) }
                ),
            delete: async (id) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.ME_EXTERNAL_AGENT_PROVIDER_BY_ID(id)}`,
                    { method: 'DELETE', headers }
                )
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            test: (id) =>
                request<{
                    ok: boolean
                    status: 'ok' | 'error'
                    message: string
                    models?: string[]
                }>(apiPaths.ME_EXTERNAL_AGENT_PROVIDER_TEST(id), {
                    method: 'POST'
                }),
            testInline: (body) =>
                request<{
                    ok: boolean
                    status: 'ok' | 'error'
                    message: string
                    models?: string[]
                }>(apiPaths.ME_EXTERNAL_AGENT_PROVIDERS_TEST_INLINE, {
                    method: 'POST',
                    body: JSON.stringify(body)
                })
        },
        skills: {
            installed: (agentId, opts) => {
                const q = new URLSearchParams()
                if (agentId) q.set('agentId', agentId)
                if (opts?.includeRuntime) q.set('includeRuntime', 'true')
                const query = q.toString()
                return request<AgentSkillsGroup[]>(
                    `${apiPaths.SKILLS_INSTALLED}${query ? `?${query}` : ''}`
                )
            },
            discover: (opts) => {
                const q = new URLSearchParams()
                if (opts?.agentId) q.set('agentId', opts.agentId)
                if (opts?.q) q.set('q', opts.q)
                if (opts?.repoId) q.set('repoId', opts.repoId)
                const query = q.toString()
                return request<DiscoverableSkillSummary[]>(
                    `${apiPaths.SKILLS_DISCOVER}${query ? `?${query}` : ''}`
                )
            },
            discoverPage: (opts) => {
                const q = new URLSearchParams()
                if (opts?.agentId) q.set('agentId', opts.agentId)
                if (opts?.q) q.set('q', opts.q)
                if (opts?.repoId) q.set('repoId', opts.repoId)
                if (opts?.category) q.set('category', opts.category)
                if (opts?.tag) q.set('tag', opts.tag)
                // sort is always sent so the API returns the paged envelope
                // instead of the legacy bare array.
                q.set('sort', opts?.sort ?? 'featured')
                if (opts?.cursor) q.set('cursor', opts.cursor)
                if (opts?.limit) q.set('limit', String(opts.limit))
                return request<DiscoverableSkillsPage>(
                    `${apiPaths.SKILLS_DISCOVER}?${q.toString()}`
                )
            },
            detail: (skillId, opts) => {
                const q = new URLSearchParams()
                if (opts?.agentId) q.set('agentId', opts.agentId)
                const query = q.toString()
                return request<DiscoverableSkillSummary>(
                    `${apiPaths.SKILLS_DISCOVER_DETAIL(skillId)}${query ? `?${query}` : ''}`
                )
            },
            readme: (skillId) =>
                request<SkillReadmeResponse>(
                    apiPaths.SKILLS_DISCOVER_README(skillId)
                ),
            refreshDiscover: (opts) => {
                const q = new URLSearchParams()
                if (opts.agentId) q.set('agentId', opts.agentId)
                if (opts.q) q.set('q', opts.q)
                if (opts.repoId) q.set('repoId', opts.repoId)
                const query = q.toString()
                return request<DiscoverableSkillSummary[]>(
                    `${apiPaths.SKILLS_DISCOVER_REFRESH}${query ? `?${query}` : ''}`,
                    { method: 'POST' }
                )
            },
            install: (body) =>
                request<InstalledSkillSummary>(apiPaths.SKILLS_INSTALL, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            installBatch: (body) =>
                request<InstallSkillBatchResult>(
                    apiPaths.SKILLS_INSTALL_BATCH,
                    { method: 'POST', body: JSON.stringify(body) }
                ),
            update: (userSkillId, body) =>
                request<InstalledSkillSummary>(
                    apiPaths.SKILL_BY_ID(userSkillId),
                    {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }
                ),
            delete: (userSkillId) =>
                deleteNoBody(apiPaths.SKILL_BY_ID(userSkillId)),
            repos: {
                list: () => request<SkillRepoSummary[]>(apiPaths.SKILL_REPOS),
                create: (body) =>
                    request<SkillRepoSummary>(apiPaths.SKILL_REPOS, {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }),
                update: (id, body) =>
                    request<SkillRepoSummary>(apiPaths.SKILL_REPO_BY_ID(id), {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }),
                delete: (id) => deleteNoBody(apiPaths.SKILL_REPO_BY_ID(id))
            },
            library: {
                list: () =>
                    request<LibrarySkillSummary[]>(apiPaths.SKILLS_LIBRARY),
                get: (id) =>
                    request<LibrarySkillDetail>(
                        apiPaths.SKILLS_LIBRARY_BY_ID(id)
                    ),
                create: (body) =>
                    request<LibrarySkillDetail>(apiPaths.SKILLS_LIBRARY, {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }),
                update: (id, body) =>
                    request<LibrarySkillDetail>(
                        apiPaths.SKILLS_LIBRARY_BY_ID(id),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                delete: (id, opts) =>
                    deleteNoBody(
                        `${apiPaths.SKILLS_LIBRARY_BY_ID(id)}${opts?.force ? '?force=true' : ''}`
                    ),
                upsertFile: (id, body) =>
                    request<LibrarySkillDetail>(
                        apiPaths.SKILLS_LIBRARY_FILES(id),
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                deleteFile: (id, fileId) =>
                    request<LibrarySkillDetail>(
                        apiPaths.SKILLS_LIBRARY_FILE_BY_ID(id, fileId),
                        { method: 'DELETE' }
                    ),
                import: (body) =>
                    request<ImportLibrarySkillResult>(
                        apiPaths.SKILLS_LIBRARY_IMPORT,
                        { method: 'POST', body: JSON.stringify(body) }
                    ),
                importArchive: async (file, filename, opts) => {
                    const token = await resolveToken(options.token)
                    const headers = new Headers()
                    if (token) headers.set('Authorization', `Bearer ${token}`)
                    const form = new FormData()
                    form.append('file', file, filename)
                    const q = opts?.onConflict
                        ? `?onConflict=${opts.onConflict}`
                        : ''
                    const res = await fetchImpl(
                        `${baseUrl}${apiPaths.SKILLS_LIBRARY_IMPORT_ARCHIVE}${q}`,
                        { method: 'POST', headers, body: form }
                    )
                    if (!res.ok) throw await buildApiError(res)
                    return res.json() as Promise<ImportLibrarySkillResult>
                },
                export: async (id) => {
                    const token = await resolveToken(options.token)
                    const headers = new Headers()
                    if (token) headers.set('Authorization', `Bearer ${token}`)
                    const res = await fetchImpl(
                        `${baseUrl}${apiPaths.SKILLS_LIBRARY_EXPORT(id)}`,
                        { method: 'GET', headers }
                    )
                    if (!res.ok) throw await buildApiError(res)
                    const disposition =
                        res.headers.get('content-disposition') ?? ''
                    const match = disposition.match(/filename="?([^";]+)"?/i)
                    const filename = match?.[1] ?? `${id}.skill`
                    const blob = await res.blob()
                    return { blob, filename }
                },
                push: (id, body) =>
                    request<PushLibrarySkillResult>(
                        apiPaths.SKILLS_LIBRARY_PUSH(id),
                        { method: 'POST', body: JSON.stringify(body ?? {}) }
                    ),
                share: (id) =>
                    request<ShareLibrarySkillResult>(
                        apiPaths.SKILLS_LIBRARY_SHARE(id),
                        { method: 'POST' }
                    ),
                revokeShare: (id) =>
                    deleteNoBody(apiPaths.SKILLS_LIBRARY_SHARE(id)),
                getShare: (id) =>
                    request<GetLibrarySkillShareResult>(
                        apiPaths.SKILLS_LIBRARY_SHARE(id)
                    )
            },
            resolveSharedSkill: (shareId) =>
                request<SharedSkillPreview>(
                    apiPaths.SKILLS_SHARED_BY_ID(shareId)
                )
        },
        automations: {
            list: (opts) => {
                const q = new URLSearchParams()
                if (opts?.agentId) q.set('agentId', opts.agentId)
                const query = q.toString()
                return request<AutomationSummary[]>(
                    `${apiPaths.AUTOMATIONS}${query ? `?${query}` : ''}`
                )
            },
            create: (body) =>
                request<AutomationDetail>(apiPaths.AUTOMATIONS, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            get: (id) =>
                request<AutomationDetail>(apiPaths.AUTOMATION_BY_ID(id)),
            update: (id, body) =>
                request<AutomationDetail>(apiPaths.AUTOMATION_BY_ID(id), {
                    method: 'PATCH',
                    body: JSON.stringify(body)
                }),
            run: (id) =>
                request<AutomationRunSummary>(apiPaths.AUTOMATION_RUN(id), {
                    method: 'POST'
                }),
            delete: (id) => deleteNoBody(apiPaths.AUTOMATION_BY_ID(id))
        },
        channels: {
            list: () => request<ChannelSummary[]>(apiPaths.CHANNELS),
            create: (body) =>
                request<ChannelDetail>(apiPaths.CHANNELS, {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            startLarkRegistration: (body) =>
                request<LarkAppRegistrationSummary>(
                    apiPaths.CHANNEL_LARK_REGISTRATIONS,
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            getLarkRegistration: (id) =>
                request<LarkAppRegistrationSummary>(
                    apiPaths.CHANNEL_LARK_REGISTRATION_BY_ID(id)
                ),
            cancelLarkRegistration: (id) =>
                deleteNoBody(apiPaths.CHANNEL_LARK_REGISTRATION_BY_ID(id)),
            startWeixinRegistration: (body) =>
                request<WeixinRegistrationSummary>(
                    apiPaths.CHANNEL_WEIXIN_REGISTRATIONS,
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            getWeixinRegistration: (id) =>
                request<WeixinRegistrationSummary>(
                    apiPaths.CHANNEL_WEIXIN_REGISTRATION_BY_ID(id)
                ),
            submitWeixinVerifyCode: (id, verifyCode) =>
                request<WeixinRegistrationSummary>(
                    apiPaths.CHANNEL_WEIXIN_REGISTRATION_VERIFY_CODE(id),
                    {
                        method: 'POST',
                        body: JSON.stringify({ verifyCode })
                    }
                ),
            cancelWeixinRegistration: (id) =>
                deleteNoBody(apiPaths.CHANNEL_WEIXIN_REGISTRATION_BY_ID(id)),
            get: (id) => request<ChannelDetail>(apiPaths.CHANNEL_BY_ID(id)),
            update: (id, body) =>
                request<ChannelDetail>(apiPaths.CHANNEL_BY_ID(id), {
                    method: 'PATCH',
                    body: JSON.stringify(body)
                }),
            delete: (id) => deleteNoBody(apiPaths.CHANNEL_BY_ID(id)),
            test: (id) =>
                request<ChannelTestResult>(apiPaths.CHANNEL_TEST(id), {
                    method: 'POST'
                }),
            register: (id) =>
                request<ChannelTestResult>(apiPaths.CHANNEL_REGISTER(id), {
                    method: 'POST'
                }),
            listDeliveries: (id, opts) => {
                const q = new URLSearchParams()
                if (opts?.limit) q.set('limit', String(opts.limit))
                const query = q.toString()
                return request<ChannelDeliverySummary[]>(
                    `${apiPaths.CHANNEL_DELIVERIES(id)}${query ? `?${query}` : ''}`
                )
            },
            slackManifest: (id) =>
                request<Record<string, unknown>>(
                    apiPaths.CHANNEL_SLACK_MANIFEST(id)
                ),
            githubAppManifest: (id, opts) => {
                const q = new URLSearchParams()
                if (opts?.org) q.set('org', opts.org)
                const query = q.toString()
                return request<GithubAppManifestResponse>(
                    `${apiPaths.CHANNEL_GITHUB_APP_MANIFEST(id)}${query ? `?${query}` : ''}`
                )
            },
            listScopes: (id) =>
                request<ChannelScopeSummary[]>(apiPaths.CHANNEL_SCOPES(id)),
            listSessions: (id, opts) => {
                const q = new URLSearchParams()
                if (opts?.scopeKey) q.set('scopeKey', opts.scopeKey)
                if (opts?.includeArchived) q.set('includeArchived', 'true')
                const query = q.toString()
                return request<ChannelSessionSummary[]>(
                    `${apiPaths.CHANNEL_SESSIONS(id)}${query ? `?${query}` : ''}`
                )
            },
            createSession: (id, body) =>
                request<ChannelSessionSummary>(apiPaths.CHANNEL_SESSIONS(id), {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            updateSession: (id, sessionId, body) =>
                request<ChannelSessionSummary>(
                    apiPaths.CHANNEL_SESSION_BY_ID(id, sessionId),
                    {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }
                ),
            deleteSession: (id, sessionId, opts) => {
                const q = new URLSearchParams()
                if (opts?.activateFallback) q.set('activateFallback', 'true')
                const query = q.toString()
                return request<{
                    archived: ChannelSessionSummary
                    fallbackActivated: ChannelSessionSummary | null
                }>(
                    `${apiPaths.CHANNEL_SESSION_BY_ID(id, sessionId)}${query ? `?${query}` : ''}`,
                    { method: 'DELETE' }
                )
            }
        },
        chat: {
            listSessions: (agentId) =>
                request<ChatSessionSummary[]>(apiPaths.AGENT_SESSIONS(agentId)),
            createSession: (agentId, body) =>
                request<ChatSessionSummary>(apiPaths.AGENT_SESSIONS(agentId), {
                    method: 'POST',
                    body: JSON.stringify(body ?? {})
                }),
            updateSession: (agentId, sessionId, body) =>
                request<ChatSessionSummary>(
                    apiPaths.AGENT_SESSION_BY_ID(agentId, sessionId),
                    {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }
                ),
            deleteSession: async (agentId, sessionId, deleteOptions) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const params = new URLSearchParams()
                if (deleteOptions?.force) params.set('force', 'true')
                const query = params.toString()
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.AGENT_SESSION_BY_ID(agentId, sessionId)}${
                        query ? `?${query}` : ''
                    }`,
                    {
                        method: 'DELETE',
                        headers
                    }
                )
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            listMessages: (agentId, sessionId, opts) =>
                request<ChatMessage[]>(
                    apiPaths.AGENT_SESSION_MESSAGES(agentId, sessionId),
                    { signal: opts?.signal }
                ),
            listMessagePage: (agentId, sessionId, opts) => {
                const query = new URLSearchParams()
                query.set(
                    'limit',
                    String(opts?.limit ?? CHAT_MESSAGE_SOFT_LIMIT)
                )
                if (opts?.before) query.set('before', opts.before)
                return request<ChatMessagesPage>(
                    `${apiPaths.AGENT_SESSION_MESSAGES(agentId, sessionId)}?${query.toString()}`,
                    { signal: opts?.signal }
                )
            },
            sendMessage: (agentId, sessionId, body) =>
                request<{
                    userMessage: ChatMessage
                    assistantMessageId: string
                }>(apiPaths.AGENT_SESSION_MESSAGES(agentId, sessionId), {
                    method: 'POST',
                    body: JSON.stringify(body)
                }),
            prewarm: (agentId) =>
                request<{ accepted: boolean }>(
                    apiPaths.AGENT_CHAT_PREWARM(agentId),
                    { method: 'POST' }
                ),
            uploadFile: async (agentId, file, filename) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const form = new FormData()
                form.append('file', file, filename)
                const res = await fetchImpl(
                    `${baseUrl}${apiPaths.AGENT_CHAT_UPLOADS(agentId)}`,
                    { method: 'POST', headers, body: form }
                )
                if (!res.ok) throw await buildApiError(res)
                return res.json() as Promise<ChatUploadResponse>
            },
            regenerateMessage: (agentId, sessionId, messageId, body) =>
                request<RegenerateMessageResponse>(
                    apiPaths.AGENT_SESSION_MESSAGE_REGENERATE(
                        agentId,
                        sessionId,
                        messageId
                    ),
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            cancelStream: async (agentId, sessionId, assistantMessageId) => {
                const token = await resolveToken(options.token)
                const headers = new Headers()
                if (token) headers.set('Authorization', `Bearer ${token}`)
                const path = apiPaths.AGENT_SESSION_CANCEL(agentId, sessionId)
                const query = assistantMessageId
                    ? `?assistantMessageId=${encodeURIComponent(assistantMessageId)}`
                    : ''
                const res = await fetchImpl(`${baseUrl}${path}${query}`, {
                    method: 'POST',
                    headers
                })
                if (!res.ok && res.status !== 204) {
                    throw await buildApiError(res)
                }
            },
            shareSession: (agentId, sessionId) =>
                request<ShareChatSessionResult>(
                    apiPaths.AGENT_SESSION_SHARE(agentId, sessionId),
                    { method: 'POST' }
                ),
            getSessionShare: (agentId, sessionId) =>
                request<GetChatSessionShareResult>(
                    apiPaths.AGENT_SESSION_SHARE(agentId, sessionId)
                ),
            revokeSessionShare: (agentId, sessionId) =>
                deleteNoBody(apiPaths.AGENT_SESSION_SHARE(agentId, sessionId)),
            resolveShared: (shareId) =>
                request<SharedChatSessionPreview>(
                    apiPaths.CHAT_SHARED_BY_ID(shareId)
                ),
            listSharedMessages: (shareId, opts) => {
                const query = new URLSearchParams()
                if (opts?.limit !== undefined)
                    query.set('limit', String(opts.limit))
                if (opts?.before) query.set('before', opts.before)
                const qs = query.toString()
                return request<SharedChatMessagesPage>(
                    `${apiPaths.CHAT_SHARED_MESSAGES(shareId)}${qs ? `?${qs}` : ''}`,
                    { signal: opts?.signal }
                )
            },
            runtimeSessionView: (agentId, body, opts) =>
                request<RuntimeSessionViewResponse>(
                    apiPaths.AGENT_RUNTIME_SESSION_VIEW(agentId),
                    {
                        method: 'POST',
                        body: JSON.stringify(body ?? {}),
                        signal: opts?.signal
                    }
                ),
            runtimeSessionRecoverRaw: (agentId, body) =>
                request<RuntimeSessionRecoverRawResponse>(
                    apiPaths.AGENT_RUNTIME_SESSION_RECOVER_RAW(agentId),
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            runtimeSessionRebuildParsed: (agentId, body) =>
                request<RuntimeSessionRebuildParsedResponse>(
                    apiPaths.AGENT_RUNTIME_SESSION_REBUILD_PARSED(agentId),
                    {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }
                ),
            runtimeSessionRestore: (agentId, sessionRef) =>
                request<RuntimeSessionRestoreResponse>(
                    apiPaths.AGENT_RUNTIME_SESSION_RESTORE(agentId),
                    {
                        method: 'POST',
                        body: JSON.stringify({ sessionRef })
                    }
                )
        },
        frameworkCatalog: {
            get: (framework) =>
                request<FrameworkCatalogView>(
                    apiPaths.FRAMEWORK_CATALOG(framework)
                )
        },
        frameworkVersions: {
            list: () =>
                request<FrameworkVersionCatalogEntry[]>(
                    apiPaths.FRAMEWORK_VERSIONS
                ),
            get: (framework) =>
                request<FrameworkVersionCatalogEntry>(
                    apiPaths.FRAMEWORK_VERSIONS_BY(framework)
                )
        },
        mcp: {
            catalog: (opts) => {
                const q = new URLSearchParams()
                if (opts?.q) q.set('q', opts.q)
                if (opts?.category) q.set('category', opts.category)
                if (opts?.tag) q.set('tag', opts.tag)
                if (opts?.sort) q.set('sort', opts.sort)
                if (opts?.cursor) q.set('cursor', opts.cursor)
                if (opts?.limit) q.set('limit', String(opts.limit))
                const query = q.toString()
                return request<McpCatalogPage>(
                    `${apiPaths.MCP_CATALOG}${query ? `?${query}` : ''}`
                )
            },
            catalogEntry: (slug) =>
                request<McpCatalogEntry>(apiPaths.MCP_CATALOG_BY_SLUG(slug)),
            library: {
                list: () => request<UserMcpServer[]>(apiPaths.MCP_LIBRARY),
                get: (id) =>
                    request<UserMcpServer>(apiPaths.MCP_LIBRARY_BY_ID(id)),
                create: (body) =>
                    request<UserMcpServer>(apiPaths.MCP_LIBRARY, {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }),
                update: (id, body) =>
                    request<UserMcpServer>(apiPaths.MCP_LIBRARY_BY_ID(id), {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }),
                delete: (id) => deleteNoBody(apiPaths.MCP_LIBRARY_BY_ID(id))
            }
        },
        catalogCategories: {
            list: (domain) =>
                request<CatalogCategorySummary[]>(
                    `${apiPaths.CATALOG_CATEGORIES}?domain=${domain}`
                )
        },
        config: {
            getCliMinimumVersion: () =>
                request<CliMinimumVersionSettings>(
                    apiPaths.CONFIG_CLI_MINIMUM_VERSION
                ),
            capabilities: () =>
                request<CapabilitiesResponse>(apiPaths.CONFIG_CAPABILITIES)
        },
        experiments: {
            me: () => request<ExperimentAssignments>(apiPaths.EXPERIMENTS_ME)
        },
        admin: {
            frameworkCatalog: {
                get: (framework) =>
                    request<FrameworkCatalogView>(
                        apiPaths.ADMIN_FRAMEWORK_CATALOG(framework)
                    ),
                createModel: (framework, body) =>
                    request<FrameworkModelView>(
                        apiPaths.ADMIN_FRAMEWORK_CATALOG_MODELS(framework),
                        { method: 'POST', body: JSON.stringify(body) }
                    ),
                updateModel: (framework, id, body) =>
                    request<FrameworkModelView>(
                        apiPaths.ADMIN_FRAMEWORK_CATALOG_MODEL_BY_ID(
                            framework,
                            id
                        ),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                deleteModel: async (framework, id) => {
                    const token = await resolveToken(options.token)
                    const headers = new Headers()
                    if (token) headers.set('Authorization', `Bearer ${token}`)
                    const res = await fetchImpl(
                        `${baseUrl}${apiPaths.ADMIN_FRAMEWORK_CATALOG_MODEL_BY_ID(framework, id)}`,
                        { method: 'DELETE', headers }
                    )
                    if (!res.ok && res.status !== 204) {
                        throw await buildApiError(res)
                    }
                },
                createEnum: (framework, body) =>
                    request<FrameworkEnumView>(
                        apiPaths.ADMIN_FRAMEWORK_CATALOG_ENUMS(framework),
                        { method: 'POST', body: JSON.stringify(body) }
                    ),
                updateEnum: (framework, id, body) =>
                    request<FrameworkEnumView>(
                        apiPaths.ADMIN_FRAMEWORK_CATALOG_ENUM_BY_ID(
                            framework,
                            id
                        ),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                deleteEnum: async (framework, id) => {
                    const token = await resolveToken(options.token)
                    const headers = new Headers()
                    if (token) headers.set('Authorization', `Bearer ${token}`)
                    const res = await fetchImpl(
                        `${baseUrl}${apiPaths.ADMIN_FRAMEWORK_CATALOG_ENUM_BY_ID(framework, id)}`,
                        { method: 'DELETE', headers }
                    )
                    if (!res.ok && res.status !== 204) {
                        throw await buildApiError(res)
                    }
                }
            },
            frameworkVersions: {
                refresh: () =>
                    request<FrameworkVersionCatalogEntry[]>(
                        apiPaths.ADMIN_FRAMEWORK_VERSIONS_REFRESH,
                        { method: 'POST' }
                    )
            },
            catalogCategories: {
                list: (opts) => {
                    const q = new URLSearchParams()
                    if (opts?.domain) q.set('domain', opts.domain)
                    const query = q.toString()
                    return request<CatalogCategorySummary[]>(
                        `${apiPaths.ADMIN_CATALOG_CATEGORIES}${query ? `?${query}` : ''}`
                    )
                },
                create: (body) =>
                    request<CatalogCategorySummary>(
                        apiPaths.ADMIN_CATALOG_CATEGORIES,
                        { method: 'POST', body: JSON.stringify(body) }
                    ),
                update: (id, body) =>
                    request<CatalogCategorySummary>(
                        apiPaths.ADMIN_CATALOG_CATEGORY_BY_ID(id),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                delete: (id) =>
                    deleteNoBody(apiPaths.ADMIN_CATALOG_CATEGORY_BY_ID(id))
            },
            mcpCatalog: {
                list: (opts) => {
                    const q = new URLSearchParams()
                    if (opts?.q) q.set('q', opts.q)
                    if (opts?.cursor) q.set('cursor', opts.cursor)
                    if (opts?.limit) q.set('limit', String(opts.limit))
                    const query = q.toString()
                    return request<AdminMcpCatalogPage>(
                        `${apiPaths.ADMIN_MCP_CATALOG}${query ? `?${query}` : ''}`
                    )
                },
                get: (id) =>
                    request<AdminMcpCatalogEntry>(
                        apiPaths.ADMIN_MCP_CATALOG_BY_ID(id)
                    ),
                create: (body) =>
                    request<AdminMcpCatalogEntry>(apiPaths.ADMIN_MCP_CATALOG, {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }),
                update: (id, body) =>
                    request<AdminMcpCatalogEntry>(
                        apiPaths.ADMIN_MCP_CATALOG_BY_ID(id),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                delete: (id) =>
                    deleteNoBody(apiPaths.ADMIN_MCP_CATALOG_BY_ID(id))
            },
            skillsCatalog: {
                list: (opts) => {
                    const q = new URLSearchParams()
                    if (opts?.q) q.set('q', opts.q)
                    if (opts?.cursor) q.set('cursor', opts.cursor)
                    if (opts?.limit) q.set('limit', String(opts.limit))
                    const query = q.toString()
                    return request<AdminSkillsCatalogPage>(
                        `${apiPaths.ADMIN_SKILLS_CATALOG}${query ? `?${query}` : ''}`
                    )
                },
                update: (skillId, body) =>
                    request<AdminSkillCatalogItem>(
                        apiPaths.ADMIN_SKILLS_CATALOG_BY_ID(skillId),
                        { method: 'PATCH', body: JSON.stringify(body) }
                    )
            },
            agents: buildAgentsClient(adminAgentPaths, deps),
            agentRuntimes: adminAgentRuntimes,
            sandboxes: {
                list: () => request<SandboxSummary[]>(apiPaths.ADMIN_SANDBOXES),
                get: (id) =>
                    request<SandboxSummary>(apiPaths.ADMIN_SANDBOX_BY_ID(id)),
                delete: (id) => deleteNoBody(apiPaths.ADMIN_SANDBOX_BY_ID(id)),
                rename: (id, name) =>
                    request<SandboxSummary>(apiPaths.ADMIN_SANDBOX_RENAME(id), {
                        method: 'PATCH',
                        body: JSON.stringify({ name } as RenameBody)
                    }),
                setTerminal: (id, enabled) =>
                    request<SandboxSummary>(
                        apiPaths.ADMIN_SANDBOX_TERMINAL(id),
                        {
                            method: 'PATCH',
                            body: JSON.stringify({
                                enabled
                            } as SetSandboxTerminalBody)
                        }
                    ),
                detectFrameworks: (id) =>
                    request<SandboxSummary>(
                        apiPaths.ADMIN_SANDBOX_DETECT_FRAMEWORKS(id),
                        { method: 'POST' }
                    ),
                refreshStatus: (id) =>
                    request<SandboxSummary>(
                        apiPaths.ADMIN_SANDBOX_REFRESH_STATUS(id),
                        { method: 'POST' }
                    ),
                upgradeCli: (id, targetVersion) =>
                    request<SandboxSummary>(
                        apiPaths.ADMIN_SANDBOX_CLI_UPGRADE(id),
                        {
                            method: 'POST',
                            body: JSON.stringify({ targetVersion })
                        }
                    ),
                listServices: (id) =>
                    request<SandboxServiceSummary[]>(
                        apiPaths.ADMIN_SANDBOX_SERVICES(id)
                    ),
                deleteService: (id, name) =>
                    deleteNoBody(
                        apiPaths.ADMIN_SANDBOX_SERVICE_BY_NAME(id, name)
                    ),
                listTasks: (id) =>
                    request<SandboxTaskSummary[]>(
                        apiPaths.ADMIN_SANDBOX_TASKS(id)
                    ),
                deleteTask: (id, name) =>
                    deleteNoBody(apiPaths.ADMIN_SANDBOX_TASK_BY_NAME(id, name)),
                stop: (id) =>
                    request<SandboxStopResponse>(
                        apiPaths.ADMIN_SANDBOX_STOP(id),
                        { method: 'POST' }
                    )
            },
            channels: {
                list: () => request<ChannelSummary[]>(apiPaths.ADMIN_CHANNELS),
                get: (id) =>
                    request<ChannelDetail>(apiPaths.ADMIN_CHANNEL_BY_ID(id)),
                update: (id, body) =>
                    request<ChannelDetail>(apiPaths.ADMIN_CHANNEL_BY_ID(id), {
                        method: 'PATCH',
                        body: JSON.stringify(body)
                    }),
                delete: (id) => deleteNoBody(apiPaths.ADMIN_CHANNEL_BY_ID(id)),
                test: (id) =>
                    request<ChannelTestResult>(
                        apiPaths.ADMIN_CHANNEL_TEST(id),
                        {
                            method: 'POST'
                        }
                    ),
                register: (id) =>
                    request<ChannelTestResult>(
                        apiPaths.ADMIN_CHANNEL_REGISTER(id),
                        { method: 'POST' }
                    )
            },
            files: buildFilesClient(adminFilesPaths, deps),
            backups: adminBackups,
            usage: buildAdminUsageClient(request),
            chatSessions: {
                list: (opts) => {
                    const q = new URLSearchParams()
                    if (opts?.agentId) q.set('agentId', opts.agentId)
                    if (opts?.userId) q.set('userId', opts.userId)
                    if (opts?.status) q.set('status', opts.status)
                    if (opts?.hasError) q.set('hasError', 'true')
                    if (opts?.q) q.set('q', opts.q)
                    if (opts?.cursor) q.set('cursor', opts.cursor)
                    if (opts?.limit) q.set('limit', String(opts.limit))
                    const query = q.toString()
                    return request<AdminChatSessionsPage>(
                        `${apiPaths.ADMIN_CHAT_SESSIONS}${query ? `?${query}` : ''}`
                    )
                },
                get: (id) =>
                    request<AdminChatSessionDetail>(
                        apiPaths.ADMIN_CHAT_SESSION_BY_ID(id)
                    ),
                listEvents: (id, opts) => {
                    const q = new URLSearchParams()
                    if (opts?.cursor) q.set('cursor', opts.cursor)
                    if (opts?.limit) q.set('limit', String(opts.limit))
                    if (opts?.order) q.set('order', opts.order)
                    if (opts?.types?.length)
                        q.set('types', opts.types.join(','))
                    if (opts?.messageId) q.set('messageId', opts.messageId)
                    const query = q.toString()
                    return request<AdminChatStreamEventsPage>(
                        `${apiPaths.ADMIN_CHAT_SESSION_EVENTS(id)}${query ? `?${query}` : ''}`
                    )
                }
            },
            daemons: {
                listHosts: () =>
                    request<AdminDaemonHostSummary[]>(
                        apiPaths.ADMIN_DAEMON_HOSTS
                    ),
                deleteHost: (id) =>
                    deleteNoBody(apiPaths.ADMIN_DAEMON_HOST_BY_ID(id)),
                upgradeHost: (id, targetVersion) =>
                    request<UpgradeDaemonHostResponse>(
                        apiPaths.ADMIN_DAEMON_HOST_UPGRADE(id),
                        {
                            method: 'POST',
                            body: JSON.stringify({ targetVersion })
                        }
                    )
            },
            modelProviders: {
                list: (opts) => {
                    const parts: string[] = []
                    if (opts?.from)
                        parts.push(`from=${encodeURIComponent(opts.from)}`)
                    if (opts?.to)
                        parts.push(`to=${encodeURIComponent(opts.to)}`)
                    const qs = parts.length ? `?${parts.join('&')}` : ''
                    return request<AdminUserModelProviderSummary[]>(
                        `${apiPaths.ADMIN_MODEL_PROVIDERS}${qs}`
                    )
                }
            },
            builtInModelPrices: {
                list: () =>
                    request<BuiltInModelPricesView>(
                        apiPaths.ADMIN_BUILT_IN_MODEL_PRICES
                    ),
                candidates: (builtInId, model, query) => {
                    const parts = [
                        `builtInId=${encodeURIComponent(builtInId)}`,
                        `model=${encodeURIComponent(model)}`
                    ]
                    if (query) parts.push(`q=${encodeURIComponent(query)}`)
                    return request<ModelPriceSourcesView>(
                        `${apiPaths.ADMIN_BUILT_IN_MODEL_PRICES_CANDIDATES}?${parts.join('&')}`
                    )
                },
                upsert: (body) =>
                    request<BuiltInModelPriceEntryView>(
                        apiPaths.ADMIN_BUILT_IN_MODEL_PRICES,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                delete: (builtInId, model) =>
                    request<void>(
                        `${apiPaths.ADMIN_BUILT_IN_MODEL_PRICES}?builtInId=${encodeURIComponent(builtInId)}&model=${encodeURIComponent(model)}`,
                        { method: 'DELETE' }
                    )
            },
            settings: {
                getLoginProvider: () =>
                    request<LoginProviderSettings>(
                        apiPaths.ADMIN_SETTINGS_LOGIN_PROVIDER
                    ),
                updateLoginProvider: (body) =>
                    request<LoginProviderSettings>(
                        apiPaths.ADMIN_SETTINGS_LOGIN_PROVIDER,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getBuiltinSkillRepos: () =>
                    request<BuiltinSkillReposSettings>(
                        apiPaths.ADMIN_SETTINGS_BUILTIN_SKILL_REPOS
                    ),
                updateBuiltinSkillRepos: (body) =>
                    request<BuiltinSkillReposSettings>(
                        apiPaths.ADMIN_SETTINGS_BUILTIN_SKILL_REPOS,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getSpritesWholesaleCap: () =>
                    request<SpritesWholesaleCapSettings>(
                        apiPaths.ADMIN_SETTINGS_SPRITES_WHOLESALE_CAP
                    ),
                updateSpritesWholesaleCap: (body) =>
                    request<SpritesWholesaleCapSettings>(
                        apiPaths.ADMIN_SETTINGS_SPRITES_WHOLESALE_CAP,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getSpritesVendorCapacity: () =>
                    request<SpritesVendorCapacityView>(
                        apiPaths.ADMIN_SETTINGS_SPRITES_VENDOR_CAPACITY
                    ),
                getAutomationRetention: () =>
                    request<AutomationRetentionSettings>(
                        apiPaths.ADMIN_SETTINGS_AUTOMATION_RETENTION
                    ),
                updateAutomationRetention: (body) =>
                    request<AutomationRetentionSettings>(
                        apiPaths.ADMIN_SETTINGS_AUTOMATION_RETENTION,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getChatExecTimeouts: () =>
                    request<ChatExecTimeoutsSettings>(
                        apiPaths.ADMIN_SETTINGS_CHAT_EXEC_TIMEOUTS
                    ),
                updateChatExecTimeouts: (body) =>
                    request<ChatExecTimeoutsSettings>(
                        apiPaths.ADMIN_SETTINGS_CHAT_EXEC_TIMEOUTS,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getA2aTurnTimeouts: () =>
                    request<A2aTurnTimeoutsSettings>(
                        apiPaths.ADMIN_SETTINGS_A2A_TURN_TIMEOUTS
                    ),
                updateA2aTurnTimeouts: (body) =>
                    request<A2aTurnTimeoutsSettings>(
                        apiPaths.ADMIN_SETTINGS_A2A_TURN_TIMEOUTS,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getCliMinimumVersion: () =>
                    request<CliMinimumVersionSettings>(
                        apiPaths.ADMIN_SETTINGS_CLI_MINIMUM_VERSION
                    ),
                updateCliMinimumVersion: (body) =>
                    request<CliMinimumVersionSettings>(
                        apiPaths.ADMIN_SETTINGS_CLI_MINIMUM_VERSION,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getFrameworkRuntimeDefaults: () =>
                    request<FrameworkRuntimeDefaultsSettings>(
                        apiPaths.ADMIN_SETTINGS_FRAMEWORK_RUNTIME_DEFAULTS
                    ),
                updateFrameworkRuntimeDefaults: (body) =>
                    request<FrameworkRuntimeDefaultsSettings>(
                        apiPaths.ADMIN_SETTINGS_FRAMEWORK_RUNTIME_DEFAULTS,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getFrameworkDefaultVersions: () =>
                    request<FrameworkDefaultVersionsSettings>(
                        apiPaths.ADMIN_SETTINGS_FRAMEWORK_DEFAULT_VERSIONS
                    ),
                updateFrameworkDefaultVersions: (body) =>
                    request<FrameworkDefaultVersionsSettings>(
                        apiPaths.ADMIN_SETTINGS_FRAMEWORK_DEFAULT_VERSIONS,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getFeatureToggles: () =>
                    request<FeatureTogglesView>(
                        apiPaths.ADMIN_SETTINGS_FEATURE_TOGGLES
                    ),
                updateFeatureToggle: (body) =>
                    request<FeatureTogglesView>(
                        apiPaths.ADMIN_SETTINGS_FEATURE_TOGGLES,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                getEmailProvider: () =>
                    request<EmailProviderSettings>(
                        apiPaths.ADMIN_SETTINGS_EMAIL_PROVIDER
                    ),
                updateEmailProvider: (body) =>
                    request<EmailProviderSettings>(
                        apiPaths.ADMIN_SETTINGS_EMAIL_PROVIDER,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                sendTestEmail: (body) =>
                    request<SendTestEmailResult>(
                        apiPaths.ADMIN_SETTINGS_EMAIL_PROVIDER_TEST,
                        { method: 'POST', body: JSON.stringify(body) }
                    )
            },
            spritesAccounts: {
                list: () =>
                    request<SdkSpritesAccountSummary[]>(
                        '/admin/sprites-accounts'
                    ),
                get: (slug) =>
                    request<SdkSpritesAccountSummary>(
                        `/admin/sprites-accounts/${encodeURIComponent(slug)}`
                    ),
                create: (input) =>
                    request<SdkSpritesAccountSummary>(
                        '/admin/sprites-accounts',
                        { method: 'POST', body: JSON.stringify(input) }
                    ),
                update: (slug, body) =>
                    request<SdkSpritesAccountSummary>(
                        `/admin/sprites-accounts/${encodeURIComponent(slug)}`,
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                rotate: (slug, token) =>
                    request<SdkSpritesAccountSummary>(
                        `/admin/sprites-accounts/${encodeURIComponent(slug)}/rotate`,
                        { method: 'POST', body: JSON.stringify({ token }) }
                    ),
                disable: (slug) =>
                    request<SdkSpritesAccountSummary>(
                        `/admin/sprites-accounts/${encodeURIComponent(slug)}/disable`,
                        { method: 'POST' }
                    ),
                enable: (slug) =>
                    request<SdkSpritesAccountSummary>(
                        `/admin/sprites-accounts/${encodeURIComponent(slug)}/enable`,
                        { method: 'POST' }
                    )
            },
            notificationWebhooks: {
                list: () =>
                    request<SdkNotificationWebhookSummary[]>(
                        '/admin/notification-webhooks'
                    ),
                get: (id) =>
                    request<SdkNotificationWebhookSummary>(
                        `/admin/notification-webhooks/${encodeURIComponent(id)}`
                    ),
                create: (body) =>
                    request<SdkNotificationWebhookSummary>(
                        '/admin/notification-webhooks',
                        { method: 'POST', body: JSON.stringify(body) }
                    ),
                update: (id, body) =>
                    request<SdkNotificationWebhookSummary>(
                        `/admin/notification-webhooks/${encodeURIComponent(id)}`,
                        { method: 'PATCH', body: JSON.stringify(body) }
                    ),
                remove: (id) =>
                    deleteNoBody(
                        `/admin/notification-webhooks/${encodeURIComponent(id)}`
                    ),
                test: (id) =>
                    request<SendTestNotificationResult>(
                        `/admin/notification-webhooks/${encodeURIComponent(id)}/test`,
                        { method: 'POST' }
                    )
            },
            clusters: {
                list: () => request<K8sClusterSummary[]>('/admin/clusters'),
                get: (id) =>
                    request<K8sClusterSummary>(
                        `/admin/clusters/${encodeURIComponent(id)}`
                    ),
                create: (body) =>
                    request<K8sClusterSummary>('/admin/clusters', {
                        method: 'POST',
                        body: JSON.stringify(body)
                    }),
                update: (id, body) =>
                    request<K8sClusterSummary>(
                        `/admin/clusters/${encodeURIComponent(id)}`,
                        { method: 'PUT', body: JSON.stringify(body) }
                    ),
                delete: async (id) => {
                    const token = await resolveToken(options.token)
                    const headers = new Headers()
                    if (token) headers.set('Authorization', `Bearer ${token}`)
                    const res = await fetchImpl(
                        `${baseUrl}/admin/clusters/${encodeURIComponent(id)}`,
                        { method: 'DELETE', headers }
                    )
                    if (!res.ok && res.status !== 204) {
                        throw await buildApiError(res)
                    }
                },
                probe: (id) =>
                    request<K8sClusterProbeResult>(
                        `/admin/clusters/${encodeURIComponent(id)}/probe`,
                        { method: 'POST' }
                    )
            },
            users: {
                list: () => request<SdkUserSummary[]>(apiPaths.ADMIN_USERS),
                setRole: (id, role) =>
                    request<SdkUserSummary>(apiPaths.ADMIN_USER_ROLE(id), {
                        method: 'PATCH',
                        body: JSON.stringify({ role })
                    }),
                setRuntimeAccess: (id, body) =>
                    request<SdkUserSummary>(
                        apiPaths.ADMIN_USER_RUNTIME_ACCESS(id),
                        {
                            method: 'PATCH',
                            body: JSON.stringify(body)
                        }
                    ),
                getRuntimeAccess: (id) =>
                    request<RuntimeAccessSummary>(
                        apiPaths.ADMIN_USER_RUNTIME_ACCESS(id)
                    ),
                getFrameworkRuntimeOverrides: (id) =>
                    request<UserFrameworkRuntimeOverridesSettings>(
                        apiPaths.ADMIN_USER_FRAMEWORK_RUNTIME_OVERRIDES(id)
                    ),
                setFrameworkRuntimeOverrides: (id, body) =>
                    request<SdkUserSummary>(
                        apiPaths.ADMIN_USER_FRAMEWORK_RUNTIME_OVERRIDES(id),
                        {
                            method: 'PATCH',
                            body: JSON.stringify(body)
                        }
                    ),
                getDeletion: (id) =>
                    request<UserDeletionStatusView | null>(
                        apiPaths.ADMIN_USER_DELETION(id)
                    ),
                requestDeletion: (id, body) =>
                    request<UserDeletionStatusView>(
                        apiPaths.ADMIN_USER_DELETION(id),
                        {
                            method: 'POST',
                            body: JSON.stringify(body ?? {})
                        }
                    ),
                restoreDeletion: (id) =>
                    request<UserDeletionStatusView>(
                        apiPaths.ADMIN_USER_DELETION_RESTORE(id),
                        { method: 'POST' }
                    ),
                executeDeletion: (id) =>
                    request<UserDeletionStatusView | null>(
                        apiPaths.ADMIN_USER_DELETION_EXECUTE(id),
                        { method: 'POST' }
                    )
            },
            sandboxQuotas: {
                overview: () =>
                    request<SandboxQuotasOverview>(
                        apiPaths.ADMIN_SANDBOX_QUOTAS_OVERVIEW
                    ),
                listUsers: (opts) => {
                    const params = new URLSearchParams()
                    if (opts?.cursor) params.set('cursor', opts.cursor)
                    if (opts?.limit !== undefined)
                        params.set('limit', String(opts.limit))
                    const qs = params.toString()
                    return request<SandboxQuotaUsersPage>(
                        `${apiPaths.ADMIN_SANDBOX_QUOTAS_USERS}${qs ? `?${qs}` : ''}`
                    )
                },
                timeseries: (range) =>
                    request<SandboxQuotaTimeseriesResponse>(
                        `${apiPaths.ADMIN_SANDBOX_QUOTAS_TIMESERIES}?range=${range}`
                    )
            }
        }
    }
}
