import {
    OFFICIAL_PROVIDER_BASE_URL,
    builtInBaseUrlForProtocol,
    builtInSupportsProtocol,
    defaultProtocolForProvider,
    isConfigurableFramework,
    isManagedProtocolAllowedForFramework,
    lookupBuiltIn,
    protocolToHermesBrand,
    protocolToOpenclawBrand
} from '@manyfold/shared'
import type {
    AgentFramework,
    BuiltInProviderEntry,
    ClaudeCodeCredentialsInput,
    CodexCredentialsInput,
    GeminiCliCredentialsInput,
    HermesCredentialsInput,
    HermesModelProvider,
    InferenceProtocol,
    OpenclawModelProvider,
    UpdateAgentCredentialsBody,
    UpdateOpenclawCredentialsInput,
    UserModelProvider
} from '@manyfold/shared'
import {
    BadRequestException,
    Inject,
    Injectable,
    NotFoundException,
    Optional
} from '@nestjs/common'
import type { CreateAgentDto } from '@/modules/agents/dto/create-agent.dto'
import {
    MANAGED_CHANNEL_GUARD_PORT,
    MANAGED_CHANNEL_UNAVAILABLE_CODE,
    type ManagedChannelGuardPort
} from '@/common/ports/managed-models.ports'
import { ModelProvidersService } from '@/modules/model-providers/model-providers.service'
import type {
    ResolvedAgentCredentials,
    ResolvedClaudeCodeCredentials,
    ResolvedCodexCredentials,
    ResolvedGeminiCliCredentials,
    ResolvedHermesCredentials,
    ResolvedOpenclawCredentials
} from '@/modules/agents/credentials/resolved-credentials'

const assertProtocol = (
    expected: InferenceProtocol | InferenceProtocol[],
    actual: InferenceProtocol
): void => {
    const allowed = Array.isArray(expected) ? expected : [expected]
    if (!allowed.includes(actual)) {
        throw new BadRequestException(
            `selected inference_protocol is "${actual}"; expected one of ${allowed.join(', ')}`
        )
    }
}

const assertManagedProtocolAllowed = (
    framework: AgentFramework,
    source: 'byo' | 'managed',
    protocol: InferenceProtocol
): void => {
    if (!isManagedProtocolAllowedForFramework(framework, source, protocol)) {
        throw new BadRequestException(
            `${framework} agents cannot use the managed Anthropic provider. ` +
                'Pick the managed OpenAI provider, or attach your own Anthropic key as a BYO provider.'
        )
    }
}

const hasOwn = <K extends PropertyKey>(
    value: object,
    key: K
): value is Record<K, unknown> =>
    Object.prototype.hasOwnProperty.call(value, key)

const normalizeNullableModel = (
    value: string | null | undefined
): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

const requireModel = (
    value: string | null | undefined,
    field: string
): string => {
    const model = normalizeNullableModel(value)
    if (!model) throw new BadRequestException(`${field} is required`)
    return model
}

// The one model-provider id a create/update body is selecting, whichever
// framework block carries it. Dify/Langflow bindings are deliberately absent:
// those point at user_external_agent_providers rows, which are BYO endpoints
// with no managed capacity behind them.
const requestedProviderId = (
    body: CreateAgentDto | UpdateAgentCredentialsBody
): string | null =>
    body.claudeCodeCredentials?.providerId ??
    body.codexCredentials?.providerId ??
    body.geminiCliCredentials?.providerId ??
    body.openclawCredentials?.providerId ??
    body.hermesCredentials?.primaryProviderId ??
    null

@Injectable()
export class CredentialsResolverService {
    constructor(
        private readonly providers: ModelProvidersService,
        @Optional()
        @Inject(MANAGED_CHANNEL_GUARD_PORT)
        private readonly managedChannelBreaker?: ManagedChannelGuardPort
    ) {}

    async resolve(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedAgentCredentials> {
        // Runtime-local agents own their model credentials inside the runtime
        // (CLI subscription sign-in). The stored payload is deliberately an
        // empty object rather than no row: decryptCreds throws on a missing
        // agent_credentials row, and the keep-alive report-token merge needs
        // a row to merge into. The DTO guard already rejected any credential
        // block riding along.
        if (
            dto.modelConfigSource === 'runtime-local' &&
            isConfigurableFramework(dto.framework)
        ) {
            return {
                framework: dto.framework,
                providerId: null,
                value: {}
            } as ResolvedAgentCredentials
        }
        await this.assertManagedChannelBindable(
            ownerUserId,
            requestedProviderId(dto),
            null
        )
        if (dto.framework === 'claude-code') {
            const value = await this.resolveClaudeCode(ownerUserId, dto)
            return {
                framework: 'claude-code',
                providerId: dto.claudeCodeCredentials?.providerId ?? null,
                value
            }
        }
        if (dto.framework === 'codex') {
            const value = await this.resolveCodex(ownerUserId, dto)
            return {
                framework: 'codex',
                providerId: dto.codexCredentials?.providerId ?? null,
                value
            }
        }
        if (dto.framework === 'gemini-cli') {
            const value = await this.resolveGeminiCli(ownerUserId, dto)
            return {
                framework: 'gemini-cli',
                providerId: dto.geminiCliCredentials?.providerId ?? null,
                value
            }
        }
        if (dto.framework === 'openclaw') {
            const value = await this.resolveOpenclaw(ownerUserId, dto)
            return {
                framework: 'openclaw',
                providerId: dto.openclawCredentials?.providerId ?? null,
                value
            }
        }
        if (dto.framework === 'narranexus') {
            return {
                framework: 'narranexus',
                providerId: null,
                value: {}
            }
        }
        if (dto.framework === 'dify') {
            const providerId = dto.difyBinding?.providerId
            if (!providerId)
                throw new BadRequestException(
                    'difyBinding.providerId is required'
                )
            return {
                framework: 'dify',
                providerId: null,
                value: { providerId }
            }
        }
        if (dto.framework === 'langflow') {
            const providerId = dto.langflowBinding?.providerId
            if (!providerId)
                throw new BadRequestException(
                    'langflowBinding.providerId is required'
                )
            return {
                framework: 'langflow',
                providerId: null,
                value: { providerId }
            }
        }
        const value = await this.resolveHermes(ownerUserId, dto)
        return {
            framework: 'hermes',
            providerId: dto.hermesCredentials?.primaryProviderId ?? null,
            value
        }
    }

    private async resolveClaudeCode(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedClaudeCodeCredentials> {
        const c = dto.claudeCodeCredentials
        if (!c) throw new BadRequestException('claudeCodeCredentials required')
        if (c.providerId) {
            const resolved = await this.fetchProvider(ownerUserId, c.providerId)
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'anthropic_messages'
                )
                return {
                    anthropicAuthToken: resolved.apiKey,
                    anthropicBaseUrl: c.anthropicBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${c.providerId} missing inference_protocol`
                )
            assertProtocol('anthropic_messages', resolved.inferenceProtocol)
            return {
                anthropicAuthToken: resolved.apiKey,
                anthropicBaseUrl:
                    c.anthropicBaseUrl ?? resolved.baseUrl ?? undefined,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        if (!c.anthropicAuthToken)
            throw new BadRequestException(
                'anthropicAuthToken or providerId required'
            )
        return {
            anthropicAuthToken: c.anthropicAuthToken,
            anthropicBaseUrl: c.anthropicBaseUrl,
            inferenceProtocol: 'anthropic_messages'
        }
    }

    private async resolveCodex(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedCodexCredentials> {
        const c = dto.codexCredentials
        if (!c) throw new BadRequestException('codexCredentials required')
        if (c.providerId) {
            const resolved = await this.fetchProvider(ownerUserId, c.providerId)
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'openai_responses'
                )
                return {
                    openaiApiKey: resolved.apiKey,
                    openaiBaseUrl: c.openaiBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${c.providerId} missing inference_protocol`
                )
            assertProtocol('openai_responses', resolved.inferenceProtocol)
            return {
                openaiApiKey: resolved.apiKey,
                openaiBaseUrl: c.openaiBaseUrl ?? resolved.baseUrl ?? undefined,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        if (!c.openaiApiKey)
            throw new BadRequestException('openaiApiKey or providerId required')
        return {
            openaiApiKey: c.openaiApiKey,
            openaiBaseUrl: c.openaiBaseUrl,
            inferenceProtocol: 'openai_responses'
        }
    }

    private async resolveGeminiCli(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedGeminiCliCredentials> {
        const c = dto.geminiCliCredentials
        if (!c) throw new BadRequestException('geminiCliCredentials required')
        if (c.providerId) {
            const resolved = await this.fetchProvider(ownerUserId, c.providerId)
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'google_generate_content'
                )
                return {
                    googleApiKey: resolved.apiKey,
                    googleGeminiBaseUrl: c.googleGeminiBaseUrl ?? baseUrl,
                    model: c.model,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${c.providerId} missing inference_protocol`
                )
            assertProtocol(
                'google_generate_content',
                resolved.inferenceProtocol
            )
            return {
                googleApiKey: resolved.apiKey,
                googleGeminiBaseUrl:
                    c.googleGeminiBaseUrl ?? resolved.baseUrl ?? undefined,
                model: c.model,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        if (!c.googleApiKey)
            throw new BadRequestException('googleApiKey or providerId required')
        return {
            googleApiKey: c.googleApiKey,
            googleGeminiBaseUrl: c.googleGeminiBaseUrl,
            model: c.model,
            inferenceProtocol: 'google_generate_content'
        }
    }

    private async resolveOpenclaw(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedOpenclawCredentials> {
        const c = dto.openclawCredentials
        if (!c) throw new BadRequestException('openclawCredentials required')
        const openclawProtocols: InferenceProtocol[] = [
            'anthropic_messages',
            'openai_chat_completions',
            'openai_responses',
            'mistral_chat_completions'
        ]
        if (c.providerId) {
            const resolved = await this.fetchProvider(ownerUserId, c.providerId)
            if (resolved.builtInId) {
                const { entry, protocol, baseUrl } =
                    this.resolveBuiltInForProtocol(
                        resolved.builtInId,
                        openclawProtocols
                    )
                assertManagedProtocolAllowed(
                    'openclaw',
                    resolved.source,
                    protocol
                )
                return {
                    modelProvider:
                        (entry.brand as OpenclawModelProvider | null) ??
                        undefined,
                    apiKey: resolved.apiKey,
                    primaryModelName: c.primaryModelName,
                    baseUrl: c.baseUrl ?? baseUrl,
                    gatewayToken: c.gatewayToken,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${c.providerId} missing inference_protocol`
                )
            assertProtocol(openclawProtocols, resolved.inferenceProtocol)
            assertManagedProtocolAllowed(
                'openclaw',
                resolved.source,
                resolved.inferenceProtocol
            )
            return {
                modelProvider:
                    protocolToOpenclawBrand(resolved.inferenceProtocol) ??
                    undefined,
                apiKey: resolved.apiKey,
                primaryModelName: c.primaryModelName,
                baseUrl: c.baseUrl ?? resolved.baseUrl ?? undefined,
                gatewayToken: c.gatewayToken,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        if (!c.apiKey || !c.modelProvider)
            throw new BadRequestException(
                'apiKey + modelProvider, or providerId, required'
            )
        return {
            modelProvider: c.modelProvider,
            apiKey: c.apiKey,
            primaryModelName: c.primaryModelName,
            baseUrl: c.baseUrl,
            gatewayToken: c.gatewayToken,
            inferenceProtocol: defaultProtocolForProvider(c.modelProvider)
        }
    }

    private async resolveHermes(
        ownerUserId: string,
        dto: CreateAgentDto
    ): Promise<ResolvedHermesCredentials> {
        const c = dto.hermesCredentials
        if (!c) throw new BadRequestException('hermesCredentials required')
        const {
            primaryModelApiKey,
            primaryModelProvider,
            primaryProviderId,
            ...rest
        } = c
        // A saved provider (or an explicit base URL) maps to hermes's `custom`
        // provider, and custom has NO default model: the agent provisions
        // fine and then every single turn dies with `HTTP 400: model is
        // required` (staging, 2026-07-29). Worse, the sprite config cannot be
        // repaired by a credentials update afterwards — so refuse at create,
        // where the fix is one field.
        if (
            !rest.primaryModelName &&
            (primaryProviderId || rest.primaryModelBaseUrl)
        )
            throw new BadRequestException(
                'hermesCredentials.primaryModelName is required when using a saved provider or base URL — hermes has no default model for custom endpoints'
            )
        const hermesProtocols: InferenceProtocol[] = [
            'anthropic_messages',
            'openai_chat_completions',
            'openai_responses',
            'mistral_chat_completions'
        ]
        if (primaryProviderId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                primaryProviderId
            )
            if (resolved.builtInId) {
                const { entry, protocol, baseUrl } =
                    this.resolveBuiltInForProtocol(
                        resolved.builtInId,
                        hermesProtocols
                    )
                assertManagedProtocolAllowed(
                    'hermes',
                    resolved.source,
                    protocol
                )
                return {
                    ...rest,
                    primaryModelApiKey: resolved.apiKey,
                    primaryModelProvider:
                        (entry.brand as HermesModelProvider | null) ??
                        undefined,
                    primaryModelBaseUrl: rest.primaryModelBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${primaryProviderId} missing inference_protocol`
                )
            assertProtocol(hermesProtocols, resolved.inferenceProtocol)
            assertManagedProtocolAllowed(
                'hermes',
                resolved.source,
                resolved.inferenceProtocol
            )
            return {
                ...rest,
                primaryModelApiKey: resolved.apiKey,
                primaryModelProvider:
                    protocolToHermesBrand(resolved.inferenceProtocol) ??
                    undefined,
                primaryModelBaseUrl:
                    rest.primaryModelBaseUrl ?? resolved.baseUrl ?? undefined,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        if (!primaryModelApiKey || !primaryModelProvider)
            throw new BadRequestException(
                'primaryModelApiKey + primaryModelProvider, or primaryProviderId, required'
            )
        return {
            ...rest,
            primaryModelApiKey,
            primaryModelProvider,
            inferenceProtocol: defaultProtocolForProvider(primaryModelProvider)
        }
    }

    // Binding is a durable choice; dispatch is a per-turn one. A managed
    // channel whose capacity scope is not closed has no proven upstream
    // accounts, so pointing a NEW agent at it — or explicitly re-pointing an
    // existing one — hands the user an agent that can only fail (#660).
    //
    // Re-selecting the provider the agent is ALREADY bound to is not a new
    // choice and stays allowed: that is what keeps an affected agent editable
    // while its channel is open, so its owner can change model, fix a base URL,
    // or migrate away without first having to wait out a cooldown.
    async assertManagedChannelBindable(
        ownerUserId: string,
        providerId: string | null,
        boundProviderId: string | null
    ): Promise<void> {
        if (!this.managedChannelBreaker) return
        if (!providerId || providerId === boundProviderId) return
        // A provider that cannot be read is not this gate's problem: the
        // resolve path below raises the real not-found/ownership error.
        const row = await this.providers
            .getOwned(ownerUserId, providerId)
            .catch(() => null)
        if (!row || row.source !== 'managed') return
        const blocked = await this.managedChannelBreaker.blockedScope(
            row.managedBrand
        )
        if (!blocked) return
        throw new BadRequestException({
            code: MANAGED_CHANNEL_UNAVAILABLE_CODE,
            message: `${this.managedChannelBreaker?.channelLabel(row.managedBrand) ?? 'That managed channel'} has no upstream accounts available right now, so agents cannot be pointed at it. Pick another model channel, or try again once it recovers.`
        })
    }

    private async fetchProvider(
        ownerUserId: string,
        id: string
    ): Promise<{
        inferenceProtocol: InferenceProtocol | null
        builtInId: string | null
        apiKey: string
        baseUrl: string | null
        source: 'byo' | 'managed'
    }> {
        try {
            return await this.providers.resolveForUser({
                userId: ownerUserId,
                id
            })
        } catch (err) {
            if (err instanceof NotFoundException) {
                throw new BadRequestException(
                    `model provider ${id} not found for owner`
                )
            }
            throw err
        }
    }

    private resolveBuiltInForProtocol(
        builtInId: string,
        wantedProtocols: InferenceProtocol | InferenceProtocol[]
    ): {
        entry: BuiltInProviderEntry
        protocol: InferenceProtocol
        baseUrl: string
    } {
        const entry = lookupBuiltIn(builtInId)
        if (!entry)
            throw new BadRequestException(
                `built-in provider ${builtInId} no longer in catalog`
            )
        const wanted = Array.isArray(wantedProtocols)
            ? wantedProtocols
            : [wantedProtocols]
        const matched = builtInSupportsProtocol(entry, wanted)
        if (!matched)
            throw new BadRequestException(
                `built-in "${entry.id}" does not expose any of: ${wanted.join(', ')}`
            )
        const baseUrl = builtInBaseUrlForProtocol(entry, matched)
        if (!baseUrl)
            throw new BadRequestException(
                `built-in "${entry.id}" missing base_url for protocol ${matched}`
            )
        return { entry, protocol: matched, baseUrl }
    }

    async resolveForUpdate(input: {
        ownerUserId: string
        framework: AgentFramework
        body: UpdateAgentCredentialsBody
        existing: ResolvedAgentCredentials
    }): Promise<ResolvedAgentCredentials> {
        const { ownerUserId, framework, body, existing } = input
        if (framework !== existing.framework)
            throw new BadRequestException(
                `framework mismatch: stored=${existing.framework} requested=${framework}`
            )
        await this.assertManagedChannelBindable(
            ownerUserId,
            requestedProviderId(body),
            existing.providerId
        )
        if (framework === 'claude-code')
            return {
                framework: 'claude-code',
                providerId:
                    body.claudeCodeCredentials?.providerId ??
                    existing.providerId,
                value: await this.updateClaudeCode(
                    ownerUserId,
                    body.claudeCodeCredentials ?? {},
                    existing.value as ResolvedClaudeCodeCredentials
                )
            }
        if (framework === 'codex')
            return {
                framework: 'codex',
                providerId:
                    body.codexCredentials?.providerId ?? existing.providerId,
                value: await this.updateCodex(
                    ownerUserId,
                    body.codexCredentials ?? {},
                    existing.value as ResolvedCodexCredentials
                )
            }
        if (framework === 'gemini-cli')
            return {
                framework: 'gemini-cli',
                providerId:
                    body.geminiCliCredentials?.providerId ??
                    existing.providerId,
                value: await this.updateGeminiCli(
                    ownerUserId,
                    body.geminiCliCredentials ?? {},
                    existing.value as ResolvedGeminiCliCredentials
                )
            }
        if (framework === 'openclaw')
            return {
                framework: 'openclaw',
                providerId:
                    body.openclawCredentials?.providerId ?? existing.providerId,
                value: await this.updateOpenclaw(
                    ownerUserId,
                    body.openclawCredentials ?? {},
                    existing.value as ResolvedOpenclawCredentials
                )
            }
        if (framework === 'hermes')
            return {
                framework: 'hermes',
                providerId:
                    body.hermesCredentials?.primaryProviderId ??
                    existing.providerId,
                value: await this.updateHermes(
                    ownerUserId,
                    body.hermesCredentials ?? {},
                    existing.value as ResolvedHermesCredentials
                )
            }
        throw new BadRequestException(
            `framework "${framework}" does not support credential updates`
        )
    }

    private async updateClaudeCode(
        ownerUserId: string,
        patch: ClaudeCodeCredentialsInput,
        existing: ResolvedClaudeCodeCredentials
    ): Promise<ResolvedClaudeCodeCredentials> {
        if (patch.providerId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                patch.providerId
            )
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'anthropic_messages'
                )
                return {
                    anthropicAuthToken: resolved.apiKey,
                    anthropicBaseUrl: patch.anthropicBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${patch.providerId} missing inference_protocol`
                )
            assertProtocol('anthropic_messages', resolved.inferenceProtocol)
            return {
                anthropicAuthToken: resolved.apiKey,
                anthropicBaseUrl:
                    patch.anthropicBaseUrl ??
                    resolved.baseUrl ??
                    existing.anthropicBaseUrl,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        return {
            anthropicAuthToken:
                patch.anthropicAuthToken ?? existing.anthropicAuthToken,
            anthropicBaseUrl:
                patch.anthropicBaseUrl ?? existing.anthropicBaseUrl,
            inferenceProtocol:
                existing.inferenceProtocol ?? 'anthropic_messages'
        }
    }

    private async updateCodex(
        ownerUserId: string,
        patch: CodexCredentialsInput,
        existing: ResolvedCodexCredentials
    ): Promise<ResolvedCodexCredentials> {
        if (patch.providerId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                patch.providerId
            )
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'openai_responses'
                )
                return {
                    openaiApiKey: resolved.apiKey,
                    openaiBaseUrl: patch.openaiBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${patch.providerId} missing inference_protocol`
                )
            assertProtocol('openai_responses', resolved.inferenceProtocol)
            return {
                openaiApiKey: resolved.apiKey,
                openaiBaseUrl:
                    patch.openaiBaseUrl ??
                    resolved.baseUrl ??
                    existing.openaiBaseUrl,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        return {
            openaiApiKey: patch.openaiApiKey ?? existing.openaiApiKey,
            openaiBaseUrl: patch.openaiBaseUrl ?? existing.openaiBaseUrl,
            inferenceProtocol: existing.inferenceProtocol ?? 'openai_responses'
        }
    }

    private async updateGeminiCli(
        ownerUserId: string,
        patch: GeminiCliCredentialsInput,
        existing: ResolvedGeminiCliCredentials
    ): Promise<ResolvedGeminiCliCredentials> {
        const model = hasOwn(patch, 'model')
            ? normalizeNullableModel(patch.model)
            : (existing.model ?? null)
        if (patch.providerId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                patch.providerId
            )
            if (resolved.builtInId) {
                const { protocol, baseUrl } = this.resolveBuiltInForProtocol(
                    resolved.builtInId,
                    'google_generate_content'
                )
                return {
                    googleApiKey: resolved.apiKey,
                    googleGeminiBaseUrl: patch.googleGeminiBaseUrl ?? baseUrl,
                    model,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${patch.providerId} missing inference_protocol`
                )
            assertProtocol(
                'google_generate_content',
                resolved.inferenceProtocol
            )
            return {
                googleApiKey: resolved.apiKey,
                googleGeminiBaseUrl:
                    patch.googleGeminiBaseUrl ??
                    resolved.baseUrl ??
                    existing.googleGeminiBaseUrl,
                model,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        return {
            googleApiKey: patch.googleApiKey ?? existing.googleApiKey,
            googleGeminiBaseUrl:
                patch.googleGeminiBaseUrl ?? existing.googleGeminiBaseUrl,
            model,
            inferenceProtocol:
                existing.inferenceProtocol ?? 'google_generate_content'
        }
    }

    private async updateOpenclaw(
        ownerUserId: string,
        patch: UpdateOpenclawCredentialsInput,
        existing: ResolvedOpenclawCredentials
    ): Promise<ResolvedOpenclawCredentials> {
        const primaryModelName = hasOwn(patch, 'primaryModelName')
            ? requireModel(patch.primaryModelName, 'primaryModelName')
            : existing.primaryModelName
        const openclawProtocols: InferenceProtocol[] = [
            'anthropic_messages',
            'openai_chat_completions',
            'openai_responses',
            'mistral_chat_completions'
        ]
        if (patch.providerId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                patch.providerId
            )
            if (resolved.builtInId) {
                const { entry, protocol, baseUrl } =
                    this.resolveBuiltInForProtocol(
                        resolved.builtInId,
                        openclawProtocols
                    )
                return {
                    modelProvider:
                        (entry.brand as OpenclawModelProvider | null) ??
                        undefined,
                    apiKey: resolved.apiKey,
                    primaryModelName,
                    baseUrl: patch.baseUrl ?? baseUrl,
                    gatewayToken: patch.gatewayToken ?? existing.gatewayToken,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${patch.providerId} missing inference_protocol`
                )
            assertProtocol(openclawProtocols, resolved.inferenceProtocol)
            return {
                modelProvider:
                    protocolToOpenclawBrand(resolved.inferenceProtocol) ??
                    undefined,
                apiKey: resolved.apiKey,
                primaryModelName,
                baseUrl: patch.baseUrl ?? resolved.baseUrl ?? existing.baseUrl,
                gatewayToken: patch.gatewayToken ?? existing.gatewayToken,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        const nextProvider = patch.modelProvider ?? existing.modelProvider
        return {
            modelProvider: nextProvider,
            apiKey: patch.apiKey ?? existing.apiKey,
            primaryModelName,
            baseUrl: patch.baseUrl ?? existing.baseUrl,
            gatewayToken: patch.gatewayToken ?? existing.gatewayToken,
            inferenceProtocol:
                existing.inferenceProtocol ??
                (nextProvider
                    ? defaultProtocolForProvider(nextProvider)
                    : undefined)
        }
    }

    private async updateHermes(
        ownerUserId: string,
        patch: HermesCredentialsInput,
        existing: ResolvedHermesCredentials
    ): Promise<ResolvedHermesCredentials> {
        const primaryModelName = hasOwn(patch, 'primaryModelName')
            ? normalizeNullableModel(patch.primaryModelName)
            : (existing.primaryModelName ?? null)
        const {
            primaryModelApiKey,
            primaryModelProvider,
            primaryProviderId,
            ...rest
        } = patch
        delete rest.primaryModelName
        const hermesProtocols: InferenceProtocol[] = [
            'anthropic_messages',
            'openai_chat_completions',
            'openai_responses',
            'mistral_chat_completions'
        ]
        if (primaryProviderId) {
            const resolved = await this.fetchProvider(
                ownerUserId,
                primaryProviderId
            )
            if (resolved.builtInId) {
                const { entry, protocol, baseUrl } =
                    this.resolveBuiltInForProtocol(
                        resolved.builtInId,
                        hermesProtocols
                    )
                return {
                    ...existing,
                    ...rest,
                    primaryModelName,
                    primaryModelApiKey: resolved.apiKey,
                    primaryModelProvider:
                        (entry.brand as HermesModelProvider | null) ??
                        undefined,
                    primaryModelBaseUrl: rest.primaryModelBaseUrl ?? baseUrl,
                    inferenceProtocol: protocol
                }
            }
            if (!resolved.inferenceProtocol)
                throw new BadRequestException(
                    `provider ${primaryProviderId} missing inference_protocol`
                )
            assertProtocol(hermesProtocols, resolved.inferenceProtocol)
            return {
                ...existing,
                ...rest,
                primaryModelName,
                primaryModelApiKey: resolved.apiKey,
                primaryModelProvider:
                    protocolToHermesBrand(resolved.inferenceProtocol) ??
                    undefined,
                primaryModelBaseUrl:
                    rest.primaryModelBaseUrl ??
                    resolved.baseUrl ??
                    existing.primaryModelBaseUrl,
                inferenceProtocol: resolved.inferenceProtocol
            }
        }
        const nextProvider =
            primaryModelProvider ?? existing.primaryModelProvider
        return {
            ...existing,
            ...rest,
            primaryModelName,
            primaryModelApiKey:
                primaryModelApiKey ?? existing.primaryModelApiKey,
            primaryModelProvider: nextProvider,
            inferenceProtocol:
                existing.inferenceProtocol ??
                (nextProvider
                    ? defaultProtocolForProvider(nextProvider)
                    : undefined)
        }
    }

    async maybePersistInline(input: {
        ownerUserId: string
        dto: CreateAgentDto
        resolved: ResolvedAgentCredentials
    }): Promise<{ created: boolean; conflict?: string } | null> {
        const save = input.dto.saveCredentialAs
        if (!save) return null

        let provider: UserModelProvider | null = null
        let apiKey: string | null = null
        let baseUrl: string | null = null

        if (input.resolved.framework === 'claude-code') {
            if (input.dto.claudeCodeCredentials?.providerId) return null
            provider = 'anthropic'
            apiKey = input.resolved.value.anthropicAuthToken
            baseUrl = input.resolved.value.anthropicBaseUrl ?? null
        } else if (input.resolved.framework === 'codex') {
            if (input.dto.codexCredentials?.providerId) return null
            provider = 'openai'
            apiKey = input.resolved.value.openaiApiKey
            baseUrl = input.resolved.value.openaiBaseUrl ?? null
        } else if (input.resolved.framework === 'gemini-cli') {
            if (input.dto.geminiCliCredentials?.providerId) return null
            provider = 'google'
            apiKey = input.resolved.value.googleApiKey
            baseUrl = input.resolved.value.googleGeminiBaseUrl ?? null
        } else if (input.resolved.framework === 'openclaw') {
            if (input.dto.openclawCredentials?.providerId) return null
            provider = input.resolved.value.modelProvider ?? null
            apiKey = input.resolved.value.apiKey ?? null
            baseUrl = input.resolved.value.baseUrl ?? null
        } else if (input.resolved.framework === 'hermes') {
            if (input.dto.hermesCredentials?.primaryProviderId) return null
            provider = input.resolved.value.primaryModelProvider ?? null
            apiKey = input.resolved.value.primaryModelApiKey ?? null
            baseUrl = input.resolved.value.primaryModelBaseUrl ?? null
        }

        if (!provider || !apiKey) return null

        return this.providers.createIfMissing({
            userId: input.ownerUserId,
            inferenceProtocol: defaultProtocolForProvider(provider),
            providerName: save.providerName,
            apiKey,
            baseUrl: baseUrl ?? OFFICIAL_PROVIDER_BASE_URL[provider]
        })
    }
}
