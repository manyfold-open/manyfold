import {
    PI_PROVIDERS,
    inputValidation,
    type PiProvider
} from '@manyfold/shared'
import { Type } from 'class-transformer'
import {
    IsIn,
    IsInt,
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

class UpdateClaudeCodeCredentialsDto {
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
}

class UpdateCodexCredentialsDto {
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
}

class UpdateGeminiCliCredentialsDto {
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
    model?: string | null

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string
}

const PI_PROVIDER_MESSAGE = (args: ValidationArguments): string =>
    args.value === undefined
        ? 'piCredentials.provider is required with apiKey'
        : `piCredentials.provider must be one of ${PI_PROVIDERS.join(', ')}`

// A pi credential is replaced whole when a key or provider arrives (the vendor
// follows the key); `baseUrl` and `model` alone patch the stored one.
class UpdatePiCredentialsDto {
    @IsOptional()
    @IsString()
    @Length(10, 1024)
    apiKey?: string

    // Required with a raw key; beside a providerId it picks which protocol a
    // multi-protocol provider serves.
    @ValidateIf(
        (o: UpdatePiCredentialsDto) => o.provider !== undefined || !!o.apiKey
    )
    @IsIn(PI_PROVIDERS, { message: PI_PROVIDER_MESSAGE })
    provider?: PiProvider

    @IsOptional()
    @IsString()
    @Length(1, 512)
    baseUrl?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    model?: string | null

    @IsOptional()
    @IsString()
    @Length(1, 64)
    providerId?: string
}

class UpdateOpenclawCredentialsDto {
    @IsOptional()
    @IsIn(['anthropic', 'openai', 'openrouter'])
    modelProvider?: 'anthropic' | 'openai' | 'openrouter'

    @IsOptional()
    @IsString()
    @Length(10, 1024)
    apiKey?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    primaryModelName?: string | null

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

class UpdateHermesEmailConfigDto {
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

class UpdateHermesCredentialsDto {
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
    primaryModelName?: string | null

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
    @Type(() => UpdateHermesEmailConfigDto)
    emailConfig?: UpdateHermesEmailConfigDto

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

class UpdateSaveCredentialAsDto {
    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    providerName!: string
}

export class UpdateAgentCredentialsDto {
    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateClaudeCodeCredentialsDto)
    claudeCodeCredentials?: UpdateClaudeCodeCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateCodexCredentialsDto)
    codexCredentials?: UpdateCodexCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateGeminiCliCredentialsDto)
    geminiCliCredentials?: UpdateGeminiCliCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdatePiCredentialsDto)
    piCredentials?: UpdatePiCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateOpenclawCredentialsDto)
    openclawCredentials?: UpdateOpenclawCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateHermesCredentialsDto)
    hermesCredentials?: UpdateHermesCredentialsDto

    @IsOptional()
    @ValidateNested()
    @Type(() => UpdateSaveCredentialAsDto)
    saveCredentialAs?: UpdateSaveCredentialAsDto
}
