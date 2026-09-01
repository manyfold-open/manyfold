import {
    AgentModelConfig,
    AgentModelConfigSource,
    SEMVER_TAG_RE,
    agentModelConfigSources,
    inputValidation,
    isConfigurableFramework,
    supportsRuntime
} from '@manyfold/shared'
import { Transform, Type } from 'class-transformer'
import {
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches,
    Max,
    Min,
    ValidateIf,
    ValidateNested,
    registerDecorator,
    type ValidationArguments,
    type ValidationOptions
} from 'class-validator'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

const BlankToUndefined = () =>
    Transform(({ value }) => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length === 0 ? undefined : trimmed
    })

const ExactlyOneOf =
    (fields: readonly string[], message: string, options?: ValidationOptions) =>
    (target: object, propertyName: string): void => {
        registerDecorator({
            name: `ExactlyOneOf_${fields.join('_')}`,
            target: target.constructor,
            propertyName,
            options: { message, ...options },
            validator: {
                validate(_value: unknown, args: ValidationArguments): boolean {
                    const o = args.object as Record<string, unknown>
                    const present = fields.filter((f) => {
                        const v = o[f]
                        return typeof v === 'string' && v.length > 0
                    })
                    return present.length === 1
                }
            }
        })
    }

const PairTogether =
    (fields: readonly string[], message: string, options?: ValidationOptions) =>
    (target: object, propertyName: string): void => {
        registerDecorator({
            name: `PairTogether_${fields.join('_')}`,
            target: target.constructor,
            propertyName,
            options: { message, ...options },
            validator: {
                validate(_value: unknown, args: ValidationArguments): boolean {
                    const o = args.object as Record<string, unknown>
                    const present = fields.filter((f) => {
                        const v = o[f]
                        return typeof v === 'string' && v.length > 0
                    })
                    return (
                        present.length === 0 || present.length === fields.length
                    )
                }
            }
        })
    }

class ClaudeCodeCredentialsDto {
    @IsOptional()
    @IsString()
    @Length(10, 1024)
    anthropicAuthToken?: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    anthropicBaseUrl?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string

    @ExactlyOneOf(
        ['anthropicAuthToken', 'providerId'],
        'exactly one of anthropicAuthToken or providerId is required'
    )
    readonly __anthropicCredGuard?: unknown
}

class CodexCredentialsDto {
    @IsOptional()
    @IsString()
    @Length(10, 1024)
    openaiApiKey?: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    openaiBaseUrl?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string

    @ExactlyOneOf(
        ['openaiApiKey', 'providerId'],
        'exactly one of openaiApiKey or providerId is required'
    )
    readonly __openaiCredGuard?: unknown
}

class GeminiCliCredentialsDto {
    @IsOptional()
    @IsString()
    @Length(10, 1024)
    googleApiKey?: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    googleGeminiBaseUrl?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    model?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string

    @ExactlyOneOf(
        ['googleApiKey', 'providerId'],
        'exactly one of googleApiKey or providerId is required'
    )
    readonly __googleCredGuard?: unknown
}

class OpenclawCredentialsDto {
    @IsOptional()
    @IsIn(['anthropic', 'openai', 'openrouter'])
    modelProvider?: 'anthropic' | 'openai' | 'openrouter'

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    apiKey?: string

    @IsString()
    @Length(1, 255)
    primaryModelName!: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    baseUrl?: string

    @IsOptional()
    @IsString()
    @Length(1, 1024)
    gatewayToken?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string
}

class HermesEmailConfigDto {
    @IsString()
    @Length(1, 255)
    host!: string

    @IsInt()
    @Min(1)
    @Max(65535)
    port!: number

    @IsString()
    @Length(1, 255)
    user!: string

    @IsString()
    @Length(1, 1024)
    password!: string
}

const SMALL_CONTEXT_MODEL_PATTERNS: Array<RegExp> = [
    /^gpt-3\.5/i,
    /^gpt-4-0613$/i,
    /^gpt-4-32k/i,
    /^claude-1/i,
    /^claude-2/i,
    /^claude-instant/i,
    /^mistral-7b(?!.*(32k|64k|128k))/i,
    /^llama-?2-(7|13|70)b(?!.*(32k|64k|128k))/i
]

const IsHermesLargeContextModel =
    (options?: ValidationOptions) =>
    (target: object, propertyName: string): void => {
        registerDecorator({
            name: 'IsHermesLargeContextModel',
            target: target.constructor,
            propertyName,
            options: {
                message:
                    'primaryModelName is known to have <64k context window; Hermes requires \u226564k',
                ...options
            },
            validator: {
                validate(value: unknown, _args: ValidationArguments): boolean {
                    if (value === undefined || value === null || value === '')
                        return true
                    if (typeof value !== 'string') return false
                    return !SMALL_CONTEXT_MODEL_PATTERNS.some((re) =>
                        re.test(value)
                    )
                }
            }
        })
    }

class DifyBindingDto {
    @IsString()
    @Length(1, 64)
    providerId!: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    appId?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    userIdentifier?: string
}

class LangflowBindingDto {
    @IsString()
    @Length(1, 64)
    providerId!: string

    @IsString()
    @Length(1, 255)
    flowId!: string

    @IsOptional()
    @IsObject()
    tweaks?: Record<string, Record<string, unknown>>
}

class A2aBindingDto {
    @IsString()
    @Length(1, 64)
    providerId!: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    selectedSkillId?: string
}

class HermesCredentialsDto {
    @IsOptional()
    @IsString()
    @Length(10, 1024)
    primaryModelApiKey?: string

    @IsOptional()
    @IsIn(['openrouter', 'anthropic', 'openai'])
    primaryModelProvider?: 'openrouter' | 'anthropic' | 'openai'

    @IsOptional()
    @IsString()
    @Length(1, 64)
    primaryProviderId?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    @IsHermesLargeContextModel()
    primaryModelName?: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    primaryModelBaseUrl?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    telegramBotToken?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    discordBotToken?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    slackAppToken?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    whatsappToken?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    signalToken?: string

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    matrixAccessToken?: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    matrixHomeserver?: string

    @IsOptional()
    @ValidateNested()
    @Type(() => HermesEmailConfigDto)
    emailConfig?: HermesEmailConfigDto

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    homeAssistantToken?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    profile?: string

    @PairTogether(
        ['matrixAccessToken', 'matrixHomeserver'],
        'matrixAccessToken and matrixHomeserver must be provided together'
    )
    readonly __matrixCredGuard?: unknown
}

class SaveCredentialAsDto {
    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    providerName!: string
}

export type AgentFrameworkInput =
    | 'claude-code'
    | 'codex'
    | 'gemini-cli'
    | 'openclaw'
    | 'hermes'
    | 'narranexus'
    | 'dify'
    | 'langflow'
    | 'a2a'

export type AgentRuntimeInput = 'sprites' | 'k8s' | 'external'

const IsRuntimeFrameworkCompatible =
    (options?: ValidationOptions) =>
    (target: object, propertyName: string): void => {
        registerDecorator({
            name: 'IsRuntimeFrameworkCompatible',
            target: target.constructor,
            propertyName,
            options: {
                message:
                    'runtime is not compatible with framework (dify/langflow/a2a must run on external; external is reserved for external frameworks)',
                ...options
            },
            validator: {
                validate(_value: unknown, args: ValidationArguments): boolean {
                    const o = args.object as CreateAgentDto
                    if (!o.framework || !o.runtime) return true
                    return supportsRuntime(o.framework, o.runtime)
                }
            }
        })
    }

// A runtime-local create means "the CLI inside the runtime owns the model
// credentials" (subscription sign-in), so it is strict XOR with every
// platform-credential input: rejecting the combination here keeps the
// resolver's short-circuit from silently discarding a key the user pasted.
const IsRuntimeLocalSourceShape =
    (options?: ValidationOptions) =>
    (target: object, propertyName: string): void => {
        registerDecorator({
            name: 'IsRuntimeLocalSourceShape',
            target: target.constructor,
            propertyName,
            options: { ...options },
            validator: {
                validate(value: unknown, args: ValidationArguments): boolean {
                    if (value !== 'runtime-local') return true
                    const o = args.object as CreateAgentDto
                    if (!o.framework) return true
                    if (!isConfigurableFramework(o.framework)) return false
                    return !(
                        o.claudeCodeCredentials ||
                        o.codexCredentials ||
                        o.geminiCliCredentials ||
                        o.saveCredentialAs
                    )
                },
                defaultMessage(args: ValidationArguments): string {
                    const o = args.object as CreateAgentDto
                    return o.framework && !isConfigurableFramework(o.framework)
                        ? 'modelConfigSource runtime-local is only available for claude-code, codex and gemini-cli'
                        : 'modelConfigSource runtime-local cannot be combined with credentials or saveCredentialAs'
                }
            }
        })
    }

export class CreateAgentDto {
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name!: string

    @IsIn([
        'claude-code',
        'codex',
        'gemini-cli',
        'openclaw',
        'hermes',
        'narranexus',
        'dify',
        'langflow',
        'a2a'
    ])
    framework!: AgentFrameworkInput

    @IsOptional()
    @IsIn(['sprites', 'k8s', 'external'])
    @IsRuntimeFrameworkCompatible()
    runtime?: AgentRuntimeInput

    @IsOptional()
    @IsString()
    @Length(1, 64)
    accountId?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    clusterId?: string

    // For k8s framework: ID of an existing purchased container (agentRuntime)
    // to attach this new agent to. Required for k8s under the purchase model.
    @IsOptional()
    @IsString()
    @Length(1, 64)
    runtimeId?: string

    // ID of an existing sandbox (runtime_hosts row) to place this agent on
    // instead of provisioning a new VM. Any sprite framework may co-reside; if
    // the sandbox already runs this framework the agent joins that instance.
    // Omit to always get a fresh VM.
    @IsOptional()
    @IsString()
    @Length(1, 64)
    sandboxId?: string

    // Pin the framework to a specific version at provision time (npm coding
    // frameworks on sprites). Omit to use the admin default / image version.
    // Early feedback only — semver shape, prereleases included. Whether a
    // prerelease may actually be installed is the opt-in's call
    // (selectFrameworkInstallVersion), and the shell boundary is guarded
    // separately by isSemverVersionTag at each install site.
    @IsOptional()
    @IsString()
    @Matches(SEMVER_TAG_RE, {
        message: 'frameworkVersion must be a semver like 1.2.3 or 1.2.3-rc.1'
    })
    frameworkVersion?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    targetUserId?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    restoreBackupId?: string

    @BlankToUndefined()
    @IsOptional()
    @IsString()
    @Length(1, 1024)
    @Matches(/^\//, { message: 'workspace must be an absolute path' })
    @Matches(/^[^\0]+$/, { message: 'workspace must not contain NUL' })
    workspace?: string

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'claude-code')
    @Type(() => ClaudeCodeCredentialsDto)
    claudeCodeCredentials?: ClaudeCodeCredentialsDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'codex')
    @Type(() => CodexCredentialsDto)
    codexCredentials?: CodexCredentialsDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'gemini-cli')
    @Type(() => GeminiCliCredentialsDto)
    geminiCliCredentials?: GeminiCliCredentialsDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'openclaw')
    @Type(() => OpenclawCredentialsDto)
    openclawCredentials?: OpenclawCredentialsDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'hermes')
    @Type(() => HermesCredentialsDto)
    hermesCredentials?: HermesCredentialsDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'dify')
    @Type(() => DifyBindingDto)
    difyBinding?: DifyBindingDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'langflow')
    @Type(() => LangflowBindingDto)
    langflowBinding?: LangflowBindingDto

    @ValidateNested()
    @ValidateIf((o: CreateAgentDto) => o.framework === 'a2a')
    @Type(() => A2aBindingDto)
    a2aBinding?: A2aBindingDto

    @IsOptional()
    @IsIn(agentModelConfigSources)
    @IsRuntimeLocalSourceShape()
    modelConfigSource?: AgentModelConfigSource

    @IsOptional()
    modelConfig?: AgentModelConfig

    @IsOptional()
    @ValidateNested()
    @Type(() => SaveCredentialAsDto)
    saveCredentialAs?: SaveCredentialAsDto
}
