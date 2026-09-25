import {
    AgentCredentialsSavedProviderRef,
    AgentCredentialsView,
    AgentFramework,
    InferenceProtocol,
    OFFICIAL_PROVIDER_BASE_URL,
    PI_PROTOCOL_BY_PROVIDER,
    UpdateAgentCredentialsBody,
    UserModelProvider,
    auditAction,
    createObjectId,
    credentialsManagedByRuntime,
    defaultProtocolForProvider,
    frameworkCapability,
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
    ResolvedPiCredentials,
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import { PodExecFactory } from '@/modules/k8s/pod-exec'
import { resolveAgentPod } from '@/modules/agents/adapters/k8s-pod-resolver'
import {
    applyCodexCredentialsOnPod,
    podScriptRunner
} from '@/modules/agent-runtimes/provisioning/pod-framework-setup'

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
        private readonly podExec: PodExecFactory,
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
        if (credentialsManagedByRuntime(agent.framework))
            return runtimeUiPlaceholderView(agent)
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
        if (credentialsManagedByRuntime(agent.framework))
            throw new BadRequestException(
                `${agent.framework} agents manage provider credentials in the native UI`
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
        if (credentialsManagedByRuntime(agent.framework))
            throw new BadRequestException({
                message: `${agent.framework} agents manage provider credentials in the native UI`,
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
        // A daemon runtime never had a row; a sprites runtime prepared on a
        // bare sandbox has none until its first agent picks a provider. Both
        // resolve from the body alone. A k8s runtime is provisioned with its
        // credentials, so a missing row there is the inconsistency it was.
        const cred =
            agent.runtime === 'daemon' || agent.runtime === 'sprites'
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
        if (frameworkCapability(resolved.framework).kind === 'service') {
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
            resolved.framework !== 'gemini-cli' &&
            resolved.framework !== 'pi'
        )
            throw new InternalServerErrorException(
                `framework ${resolved.framework} should not run on sprites`
            )
        // Claude Code, Gemini CLI and pi keep nothing a credential decides on
        // the sprite: the key rides each exec, and pi's endpoint is written
        // into its platform view at every start (pi-agent-dir.ts).
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

    // A pod host (ADR-0035): every framework's key rides each exec, so only
    // codex, which reads its endpoint and MCP servers from config.toml, has
    // anything on the host to rewrite.
    private async applyOnK8s(
        agent: Agent,
        resolved: ResolvedAgentCredentials
    ): Promise<void> {
        if (frameworkCapability(resolved.framework).kind === 'service')
            throw new ConflictException(
                `${resolved.framework} cannot run on a cloud computer yet`
            )
        if (resolved.framework !== 'codex') return
        const runtime = agent.runtimeId
            ? await this.runtimes.findById(agent.runtimeId)
            : null
        if (!runtime)
            throw new InternalServerErrorException(
                `runtime ${agent.runtimeId} not found for agent ${agent.id}`
            )
        const pod = await resolveAgentPod(this.k8s, runtime)
        const exec = this.podExec.forClient(
            pod.client,
            pod.namespace,
            pod.podName,
            pod.containerName
        )
        const composioKey = await decryptComposioKey(
            this.db,
            this.crypto,
            agent.userId,
            (agent.extras as { composioConnectionId?: string | null })
                .composioConnectionId
        )
        await applyCodexCredentialsOnPod({
            runner: podScriptRunner(exec, (event, fields) =>
                this.log.warn(`${event} ${JSON.stringify(fields)}`)
            ),
            baseUrl: resolved.value.openaiBaseUrl ?? null,
            mcpToml: mcpConfigFromExtras(agent.extras).global ?? null,
            composioKey
        })
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
        if (credentialsManagedByRuntime(framework))
            throw new BadRequestException(
                `${framework} credentials live in the runtime, not Manyfold`
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

const runtimeUiPlaceholderView = (agent: Agent): AgentCredentialsView => ({
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
    if (resolved.framework === 'pi') {
        const v = resolved.value as ResolvedPiCredentials
        return {
            provider: v.provider,
            inferenceProtocol:
                v.inferenceProtocol ?? PI_PROTOCOL_BY_PROVIDER[v.provider],
            apiKey: v.apiKey ?? null,
            baseUrl: v.baseUrl ?? null,
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
    if (resolved.framework === 'pi')
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
        case 'pi':
            return 'piCredentials'
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
    if (framework === 'pi' && body.piCredentials?.providerId)
        return 'providerId'
    if (framework === 'openclaw' && body.openclawCredentials?.providerId)
        return 'providerId'
    if (framework === 'hermes' && body.hermesCredentials?.primaryProviderId)
        return 'providerId'
    return 'inline'
}
