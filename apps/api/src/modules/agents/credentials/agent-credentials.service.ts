import {
    AgentCredentialsSavedProviderRef,
    AgentCredentialsView,
    AgentFramework,
    InferenceProtocol,
    OFFICIAL_PROVIDER_BASE_URL,
    UpdateAgentCredentialsBody,
    UserModelProvider,
    auditAction,
    createObjectId,
    defaultProtocolForProvider,
    isExternal,
    mcpConfigFromExtras
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { PatchStrategy, setHeaderOptions } from '@kubernetes/client-node'
import {
    createClient as createSpritesClient,
    type SpritesLogger
} from '@manyfold/sprites'
import {
    agentCredentials,
    agents as agentsTable,
    type Agent,
    type AgentCredential,
    type Database
} from '@manyfold/db'
import { auditLogs } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { AgentServiceRestartService } from '@/modules/agents/agent-service-restart.service'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { KubernetesService } from '@/modules/k8s/kubernetes.service'
import { SpritesAccountsService } from '@/modules/sprites-accounts/sprites-accounts.service'
import { AgentsService } from '@/modules/agents/agents.service'
import { AgentRuntimesService } from '@/modules/agent-runtimes/agent-runtimes.service'
import { CredentialsResolverService } from '@/modules/agents/credentials/credentials-resolver.service'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'
import { applyCodexCredentialsOnSprite } from '@/modules/agents/credentials/codex-credential-apply'
import { decryptComposioKey } from '@/modules/connections/composio-key'
import { RuntimeAccessService } from '@/modules/runtime-access/runtime-access.service'
import type {
    ResolvedAgentCredentials,
    ResolvedClaudeCodeCredentials,
    ResolvedCodexCredentials,
    ResolvedGeminiCliCredentials,
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import { HermesBootstrap } from '@/modules/agents/bootstrap/hermes'
import { OpenClawBootstrap } from '@/modules/agents/bootstrap/openclaw'
import { ClaudeCodeK8sBootstrap } from '@/modules/agents/bootstrap/claude-code-k8s'
import { CodexK8sBootstrap } from '@/modules/agents/bootstrap/codex-k8s'
import { GeminiCliK8sBootstrap } from '@/modules/agents/bootstrap/gemini-k8s'
import type {
    K8sBootstrapContext,
    K8sFramework,
    K8sFrameworkBootstrap
} from '@/modules/agents/bootstrap/k8s-framework-bootstrap'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import {
    buildSecret,
    resourceName,
    type K8sResourceSpec
} from '@/modules/agents/orchestration/k8s-resource-builder'

const maskApiKey = (raw: string | null | undefined): string | null => {
    if (!raw) return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length <= 8) return '***'
    const dashIdx = trimmed.search(/[_-]/)
    const prefixEnd =
        dashIdx > 0 && dashIdx < 10 ? dashIdx + 1 : Math.min(4, trimmed.length)
    const prefix = trimmed.slice(0, prefixEnd)
    const tail = trimmed.slice(-4)
    return `${prefix}***${tail}`
}

@Injectable()
export class AgentCredentialsService {
    private readonly log = new Logger(AgentCredentialsService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly agents: AgentsService,
        private readonly resolver: CredentialsResolverService,
        private readonly modelProviders: ModelProvidersService,
        private readonly k8s: KubernetesService,
        private readonly accounts: SpritesAccountsService,
        private readonly runtimes: AgentRuntimesService,
        private readonly hermes: HermesBootstrap,
        private readonly openclaw: OpenClawBootstrap,
        private readonly claudeCodeK8s: ClaudeCodeK8sBootstrap,
        private readonly codexK8s: CodexK8sBootstrap,
        private readonly geminiCliK8s: GeminiCliK8sBootstrap,
        private readonly runtimeAccess: RuntimeAccessService,
        // Appended LAST and @Optional so positional test construction keeps
        // working; without it, gateway-framework credential updates degrade
        // to the saved-but-rebuild-to-apply 409.
        @Optional()
        private readonly serviceRestart?: AgentServiceRestartService
    ) {}

    async getView(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<AgentCredentialsView> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        if (agent.runtime === 'daemon') {
            const cred = await this.findCredentialsRow(agent)
            if (!cred) return daemonPlaceholderView(agent)
            const resolved = this.decryptResolved(cred, agent.framework)
            const savedProvider = await this.findSavedProvider(
                agent.userId,
                resolved
            )
            return {
                ...toView(
                    agent.framework,
                    resolved,
                    cred.updatedAt,
                    savedProvider
                ),
                localManaged: true
            }
        }
        if (agent.framework === 'narranexus')
            return narranexusPlaceholderView(agent)
        if (isExternal(agent.framework))
            return externalPlaceholderView(agent)
        const cred = await this.requireCredentialsRow(agent)
        const resolved = this.decryptResolved(cred, agent.framework)
        const savedProvider = await this.findSavedProvider(
            agent.userId,
            resolved
        )
        return toView(agent.framework, resolved, cred.updatedAt, savedProvider)
    }

    async reveal(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<{ apiKey: string }> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        if (agent.runtime === 'daemon')
            throw new BadRequestException({
                message:
                    'daemon agents manage credentials locally; reveal is unavailable',
                code: 'credentials_local_managed'
            })
        if (agent.framework === 'narranexus')
            throw new BadRequestException(
                'narranexus agents manage provider credentials in the native UI'
            )
        if (isExternal(agent.framework))
            throw new BadRequestException(
                'external-runtime agents have provider credentials in /me/external-agent-providers'
            )
        const cred = await this.requireCredentialsRow(agent)
        const resolved = this.decryptResolved(cred, agent.framework)
        const apiKey = extractPrimaryApiKey(resolved)
        if (!apiKey)
            throw new NotFoundException(
                `agent ${agent.id} has no api key stored — rebuild the agent`
            )
        await this.audit(
            callerUserId,
            auditAction.AGENT_CREDENTIALS_REVEALED,
            agent.id,
            {
                framework: agent.framework,
                ownerUserId: agent.userId,
                onBehalfOf: callerUserId !== agent.userId
            }
        )
        return { apiKey }
    }

    async update(
        callerUserId: string,
        agentId: string,
        body: UpdateAgentCredentialsBody,
        isAdmin: boolean
    ): Promise<AgentCredentialsView> {
        const agent = await this.requireAgent(callerUserId, agentId, isAdmin)
        if (agent.framework === 'narranexus')
            throw new BadRequestException({
                message:
                    'narranexus agents manage provider credentials in the native UI',
                code: 'unsupported_framework'
            })
        if (isExternal(agent.framework))
            throw new BadRequestException({
                message:
                    'external-runtime agents have provider credentials in /me/external-agent-providers',
                code: 'unsupported_framework'
            })
        if (!hasAnyPatch(agent.framework, body))
            throw new BadRequestException(
                `body must contain ${frameworkBodyKey(agent.framework)} for framework "${agent.framework}"`
            )
        const cred =
            agent.runtime === 'daemon'
                ? await this.findCredentialsRow(agent)
                : await this.requireCredentialsRow(agent)
        const next = cred
            ? await this.resolver.resolveForUpdate({
                  ownerUserId: agent.userId,
                  framework: agent.framework,
                  body,
                  existing: this.decryptResolved(cred, agent.framework)
              })
            : await this.resolver.resolve(agent.userId, {
                  framework: agent.framework,
                  ...body
              } as CreateAgentDto)

        const enc = this.crypto.encrypt(JSON.stringify(next.value))
        const savedAt = new Date()
        if (cred) {
            await this.db
                .update(agentCredentials)
                .set({
                    payloadCiphertext: enc.ciphertext,
                    keyVersion: enc.keyVersion,
                    updatedAt: savedAt
                })
                .where(eq(agentCredentials.id, cred.id))
        } else {
            await this.db.insert(agentCredentials).values({
                id: createObjectId('agentCredential'),
                runtimeId: agent.runtimeId,
                framework: agent.framework,
                payloadCiphertext: enc.ciphertext,
                keyVersion: enc.keyVersion,
                createdAt: savedAt,
                updatedAt: savedAt
            })
        }

        if (next.providerId !== agent.modelProviderId) {
            await this.db
                .update(agentsTable)
                .set({ modelProviderId: next.providerId, updatedAt: savedAt })
                .where(eq(agentsTable.id, agent.id))
        }

        try {
            if (agent.runtime === 'sprites') {
                await this.applyOnSprite(agent, next)
            } else if (agent.runtime === 'k8s') {
                await this.applyOnK8s(agent, next)
            }
            await this.syncAgentDefaultModel(agent, next)
        } catch (err) {
            await this.audit(
                callerUserId,
                auditAction.AGENT_CREDENTIALS_UPDATED,
                agent.id,
                {
                    framework: agent.framework,
                    ownerUserId: agent.userId,
                    onBehalfOf: callerUserId !== agent.userId,
                    runtimeApplyError: (err as Error).message.slice(0, 256)
                }
            )
            throw new InternalServerErrorException({
                message: `credentials saved but runtime apply failed: ${(err as Error).message}`,
                code: 'runtime_apply_failed'
            })
        }

        await this.audit(
            callerUserId,
            auditAction.AGENT_CREDENTIALS_UPDATED,
            agent.id,
            {
                framework: agent.framework,
                ownerUserId: agent.userId,
                onBehalfOf: callerUserId !== agent.userId,
                providerSwitch: providerSwitchHint(agent.framework, body)
            }
        )

        if (
            body.saveCredentialAs &&
            providerSwitchHint(agent.framework, body) === 'inline'
        ) {
            await this.persistAsSavedProvider(
                agent.userId,
                next,
                body.saveCredentialAs.providerName
            ).catch((err: unknown) => {
                this.log.warn(
                    `saveCredentialAs failed for ${agent.userId}: ${(err as Error).message}`
                )
            })
        }

        const savedProvider = await this.findSavedProvider(agent.userId, next)
        const view = toView(agent.framework, next, savedAt, savedProvider)
        return agent.runtime === 'daemon'
            ? { ...view, localManaged: true }
            : view
    }

    private async persistAsSavedProvider(
        userId: string,
        resolved: ResolvedAgentCredentials,
        providerName: string
    ): Promise<void> {
        const detail = providerDetail(resolved)
        if (!detail.provider || !detail.apiKey) return
        await this.modelProviders.createIfMissing({
            userId,
            inferenceProtocol:
                detail.inferenceProtocol ??
                defaultProtocolForProvider(detail.provider),
            providerName,
            apiKey: detail.apiKey,
            baseUrl:
                detail.baseUrl ?? OFFICIAL_PROVIDER_BASE_URL[detail.provider]
        })
    }

    private async syncAgentDefaultModel(
        agent: Agent,
        resolved: ResolvedAgentCredentials
    ): Promise<void> {
        const model = defaultModelFromResolved(resolved)
        if (model === undefined || model === agent.model) return
        await this.db
            .update(agentsTable)
            .set({ model, updatedAt: new Date() })
            .where(eq(agentsTable.id, agent.id))
    }

    private async findSavedProvider(
        userId: string,
        resolved: ResolvedAgentCredentials
    ): Promise<AgentCredentialsSavedProviderRef | null> {
        const apiKey = extractPrimaryApiKey(resolved)
        if (!apiKey) return null
        const match = await this.modelProviders.findByApiKey({
            userId,
            apiKey
        })
        if (!match) return null
        return { id: match.id, providerName: match.providerName }
    }

    private async applyOnSprite(
        agent: Agent,
        resolved: ResolvedAgentCredentials
    ): Promise<void> {
        if (
            resolved.framework === 'hermes' ||
            resolved.framework === 'openclaw' ||
            resolved.framework === 'narranexus'
        ) {
            // Gateway frameworks keep their model/provider in files and
            // service env the bootstrap wrote. The restart service re-runs
            // exactly that bootstrap dance with the freshly saved creds —
            // for hermes that includes rewriting ~/.hermes/config.yaml, the
            // file `hermes acp` and the gateway actually read (saved-but-
            // never-applied credentials left agents failing `model is
            // required` until recreated; staging 2026-07-29).
            if (!this.serviceRestart)
                throw new ConflictException(
                    `${resolved.framework} sprite config cannot be updated in place — credentials are saved; rebuild the agent to apply them`
                )
            await this.serviceRestart.restart(agent.id, agent.userId, false)
            return
        }
        if (
            resolved.framework !== 'codex' &&
            resolved.framework !== 'claude-code' &&
            resolved.framework !== 'gemini-cli'
        )
            throw new InternalServerErrorException(
                `framework ${resolved.framework} should not run on sprites`
            )
        if (resolved.framework !== 'codex') return
        if (!agent.spriteName || !agent.accountId || !agent.hostId)
            throw new InternalServerErrorException(
                `agent ${agent.id} has no sprite to update`
            )
        await this.runtimeAccess.reserveActiveSlot({
            userId: agent.userId,
            hostId: agent.hostId
        })
        const account = await this.accounts.getById(agent.accountId)
        if (!account)
            throw new NotFoundException(
                `sprites account ${agent.accountId} not found`
            )
        const token = this.accounts.decryptToken(account)
        const client = createSpritesClient({
            token,
            accountSlug: account.slug
        })
        const composioKey = await decryptComposioKey(
            this.db,
            this.crypto,
            agent.userId,
            (agent.extras as { composioConnectionId?: string | null })
                .composioConnectionId
        )
        await applyCodexCredentialsOnSprite({
            client,
            spriteName: agent.spriteName,
            apiKey: resolved.value.openaiApiKey,
            baseUrl: resolved.value.openaiBaseUrl ?? null,
            mcpToml: mcpConfigFromExtras(agent.extras).global ?? null,
            composioKey,
            logger: spritesLoggerFrom(this.log)
        })
    }

    private async applyOnK8s(
        agent: Agent,
        resolved: ResolvedAgentCredentials
    ): Promise<void> {
        if (!agent.namespace)
            throw new InternalServerErrorException(
                `agent ${agent.id} has no namespace`
            )
        if (!agent.runtimeId)
            throw new InternalServerErrorException(
                `agent ${agent.id} has no runtimeId`
            )
        const runtime = await this.runtimes.findById(agent.runtimeId)
        if (!runtime)
            throw new InternalServerErrorException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        const bootstrap = this.pickK8sBootstrap(agent.framework as K8sFramework)
        const ctx: K8sBootstrapContext = {
            agentId: agent.id,
            runtimeId: agent.runtimeId,
            userId: agent.userId,
            namespace: agent.namespace,
            host: agent.ingressHost ?? '',
            image: '',
            controlUiEnabled: runtime.controlUiEnabled,
            dashboardEnabled: runtime.dashboardEnabled
        }
        const plan = bootstrap.plan(ctx, resolved.value)
        const envSecretName = `${resourceName(agent.id)}-env`
        const spec: K8sResourceSpec = {
            agentId: agent.id,
            userId: agent.userId,
            namespace: agent.namespace,
            framework: agent.framework as K8sFramework,
            image: '',
            port: plan.port,
            host: agent.ingressHost ?? '',
            storageClass: '',
            pvcMountPath: plan.pvcMountPath,
            envSecretName,
            envSecretKeys: Object.keys(plan.envSecretData)
        }
        const k8sClient = await this.k8s.getClient(agent.clusterId)
        const apis = k8sClient.apis
        await apis.core.replaceNamespacedSecret({
            name: envSecretName,
            namespace: agent.namespace,
            body: buildSecret(spec, plan.envSecretData)
        })
        await apis.apps.patchNamespacedDeployment(
            {
                name: resourceName(agent.id),
                namespace: agent.namespace,
                body: {
                    spec: {
                        template: {
                            metadata: {
                                annotations: {
                                    'nca.netmind.ai/restartedAt':
                                        new Date().toISOString()
                                }
                            }
                        }
                    }
                }
            },
            setHeaderOptions('Content-Type', PatchStrategy.StrategicMergePatch)
        )
    }

    private async requireAgent(
        callerUserId: string,
        agentId: string,
        isAdmin: boolean
    ): Promise<Agent> {
        const agent = await this.agents.findForCaller(
            agentId,
            callerUserId,
            isAdmin
        )
        if (!agent) throw new NotFoundException(`agent ${agentId} not found`)
        return agent
    }

    private async requireCredentialsRow(
        agent: Agent
    ): Promise<AgentCredential> {
        const row = await this.findCredentialsRow(agent)
        if (!row)
            throw new NotFoundException(
                `agent ${agent.id} has no stored credentials — rebuild the agent`
            )
        return row
    }

    private async findCredentialsRow(
        agent: Agent
    ): Promise<AgentCredential | null> {
        if (!agent.runtimeId)
            throw new InternalServerErrorException(
                `agent ${agent.id} has no runtimeId`
            )
        const [row] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, agent.runtimeId))
            .limit(1)
        return row ?? null
    }

    private decryptResolved(
        cred: AgentCredential,
        framework: AgentFramework
    ): ResolvedAgentCredentials {
        const plain = this.crypto.decrypt({
            ciphertext: cred.payloadCiphertext,
            keyVersion: cred.keyVersion
        })
        const parsed = JSON.parse(plain) as Record<string, unknown>
        if (framework === 'narranexus')
            throw new BadRequestException(
                'narranexus credentials live in the runtime sqlite, not Manyfold'
            )
        if (isExternal(framework))
            throw new BadRequestException(
                'external-runtime credentials live on the provider, not the agent'
            )
        return {
            framework,
            value: parsed
        } as ResolvedAgentCredentials
    }

    private pickK8sBootstrap(framework: K8sFramework): K8sFrameworkBootstrap {
        switch (framework) {
            case 'openclaw':
                return this.openclaw
            case 'hermes':
                return this.hermes
            case 'claude-code':
                return this.claudeCodeK8s
            case 'codex':
                return this.codexK8s
            case 'gemini-cli':
                return this.geminiCliK8s
            case 'narranexus':
                throw new InternalServerErrorException(
                    'narranexus credentials do not flow through K8s bootstrap apply'
                )
        }
    }

    private async audit(
        actorId: string,
        action: string,
        subject: string,
        meta: Record<string, unknown>
    ): Promise<void> {
        try {
            await this.db.insert(auditLogs).values({
                id: randomUUID(),
                actorId,
                action,
                subject,
                meta
            })
        } catch (err) {
            this.log.warn(
                `audit write failed action=${action} err=${(err as Error).message}`
            )
        }
    }
}

const externalPlaceholderView = (agent: Agent): AgentCredentialsView => ({
    framework: agent.framework,
    provider: null,
    apiKeyMasked: null,
    baseUrl: null,
    savedProvider: null,
    extras: {},
    updatedAt: agent.updatedAt.toISOString(),
    localManaged: false
})

const daemonPlaceholderView = (agent: Agent): AgentCredentialsView => ({
    framework: agent.framework,
    provider: null,
    apiKeyMasked: null,
    baseUrl: null,
    savedProvider: null,
    extras: {},
    localManaged: true,
    updatedAt: agent.updatedAt.toISOString()
})

const narranexusPlaceholderView = (agent: Agent): AgentCredentialsView => ({
    framework: agent.framework,
    provider: null,
    apiKeyMasked: null,
    baseUrl: null,
    savedProvider: null,
    extras: {},
    unsupported: true,
    updatedAt: agent.updatedAt.toISOString()
})

const toView = (
    framework: AgentFramework,
    resolved: ResolvedAgentCredentials,
    updatedAt: Date,
    savedProvider: AgentCredentialsSavedProviderRef | null
): AgentCredentialsView => {
    const detail = providerDetail(resolved)
    return {
        framework,
        provider: detail.provider,
        apiKeyMasked: maskApiKey(detail.apiKey),
        baseUrl: detail.baseUrl,
        savedProvider,
        extras: detail.extras,
        updatedAt: updatedAt.toISOString()
    }
}

interface ProviderDetail {
    provider: UserModelProvider | null
    inferenceProtocol: InferenceProtocol | null
    apiKey: string | null
    baseUrl: string | null
    extras: AgentCredentialsView['extras']
}

const providerDetail = (resolved: ResolvedAgentCredentials): ProviderDetail => {
    if (resolved.framework === 'claude-code') {
        const v = resolved.value as ResolvedClaudeCodeCredentials
        return {
            provider: 'anthropic',
            inferenceProtocol: v.inferenceProtocol ?? 'anthropic_messages',
            apiKey: v.anthropicAuthToken ?? null,
            baseUrl: v.anthropicBaseUrl ?? null,
            extras: {}
        }
    }
    if (resolved.framework === 'codex') {
        const v = resolved.value as ResolvedCodexCredentials
        return {
            provider: 'openai',
            inferenceProtocol: v.inferenceProtocol ?? 'openai_responses',
            apiKey: v.openaiApiKey ?? null,
            baseUrl: v.openaiBaseUrl ?? null,
            extras: {}
        }
    }
    if (resolved.framework === 'gemini-cli') {
        const v = resolved.value as ResolvedGeminiCliCredentials
        return {
            provider: 'google',
            inferenceProtocol:
                v.inferenceProtocol ?? 'google_generate_content',
            apiKey: v.googleApiKey ?? null,
            baseUrl: v.googleGeminiBaseUrl ?? null,
            extras: { model: v.model ?? null }
        }
    }
    if (resolved.framework === 'openclaw') {
        const v = resolved.value as ResolvedOpenclawCredentials
        const provider = (v.modelProvider ?? null) as UserModelProvider | null
        return {
            provider,
            inferenceProtocol:
                v.inferenceProtocol ??
                (provider ? defaultProtocolForProvider(provider) : null),
            apiKey: v.apiKey ?? null,
            baseUrl: v.baseUrl ?? null,
            extras: {
                primaryModelName: v.primaryModelName ?? null,
                gatewayToken: v.gatewayToken ? '***' : null
            }
        }
    }
    const v = resolved.value as ResolvedHermesCredentials
    const provider = (v.primaryModelProvider ?? null) as UserModelProvider | null
    return {
        provider,
        inferenceProtocol:
            v.inferenceProtocol ??
            (provider ? defaultProtocolForProvider(provider) : null),
        apiKey: v.primaryModelApiKey ?? null,
        baseUrl: v.primaryModelBaseUrl ?? null,
        extras: {
            primaryModelName: v.primaryModelName ?? null,
            apiServerKey: v.apiServerKey ? '***' : null,
            profile: v.profile ?? null
        }
    }
}

const extractPrimaryApiKey = (
    resolved: ResolvedAgentCredentials
): string | null => providerDetail(resolved).apiKey

const normalizeDefaultModel = (
    value: string | null | undefined
): string | null => {
    const model = typeof value === 'string' ? value.trim() : ''
    return model.length > 0 ? model : null
}

const defaultModelFromResolved = (
    resolved: ResolvedAgentCredentials
): string | null | undefined => {
    if (resolved.framework === 'gemini-cli')
        return normalizeDefaultModel(resolved.value.model)
    if (resolved.framework === 'openclaw')
        return normalizeDefaultModel(resolved.value.primaryModelName)
    if (resolved.framework === 'hermes')
        return normalizeDefaultModel(resolved.value.primaryModelName)
    return undefined
}

const frameworkBodyKey = (framework: AgentFramework): string => {
    switch (framework) {
        case 'claude-code':
            return 'claudeCodeCredentials'
        case 'codex':
            return 'codexCredentials'
        case 'gemini-cli':
            return 'geminiCliCredentials'
        case 'openclaw':
            return 'openclawCredentials'
        case 'hermes':
            return 'hermesCredentials'
        default:
            return 'credentials'
    }
}

const hasAnyPatch = (
    framework: AgentFramework,
    body: UpdateAgentCredentialsBody
): boolean => {
    const key = frameworkBodyKey(framework) as keyof UpdateAgentCredentialsBody
    const value = body[key]
    if (!value) return false
    return Object.values(value).some((v) => v !== undefined)
}

const spritesLoggerFrom = (log: Logger): SpritesLogger => ({
    debug: () => {},
    info: (m, meta) => log.log(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    warn: (m, meta) => log.warn(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`),
    error: (m, meta) =>
        log.error(`[sprites] ${m} ${JSON.stringify(meta ?? {})}`)
})

const providerSwitchHint = (
    framework: AgentFramework,
    body: UpdateAgentCredentialsBody
): string => {
    if (framework === 'claude-code' && body.claudeCodeCredentials?.providerId)
        return 'providerId'
    if (framework === 'codex' && body.codexCredentials?.providerId)
        return 'providerId'
    if (framework === 'gemini-cli' && body.geminiCliCredentials?.providerId)
        return 'providerId'
    if (framework === 'openclaw' && body.openclawCredentials?.providerId)
        return 'providerId'
    if (framework === 'hermes' && body.hermesCredentials?.primaryProviderId)
        return 'providerId'
    return 'inline'
}
