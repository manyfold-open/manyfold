import {
    ExternalAgentProviderKind,
    inputValidation
} from '@manyfold/shared'
import {
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches
} from 'class-validator'

const PROVIDERS: ExternalAgentProviderKind[] = ['dify', 'langflow']

export class CreateUserExternalAgentProviderDto {
    @IsString()
    @IsIn(PROVIDERS)
    provider!: ExternalAgentProviderKind

    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    label!: string

    @IsString()
    @Length(1, 1024)
    @Matches(/^https?:\/\//, { message: 'endpointUrl must be http(s)' })
    endpointUrl!: string

    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey!: string

    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>
}

export class UpdateUserExternalAgentProviderDto {
    @IsOptional()
    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    label?: string

    @IsOptional()
    @IsString()
    @Length(1, 1024)
    @Matches(/^https?:\/\//, { message: 'endpointUrl must be http(s)' })
    endpointUrl?: string

    @IsOptional()
    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey?: string

    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>
}

export class TestExternalAgentProviderInlineDto {
    @IsString()
    @IsIn(PROVIDERS)
    provider!: ExternalAgentProviderKind

    @IsString()
    @Length(1, 1024)
    @Matches(/^https?:\/\//)
    endpointUrl!: string

    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey!: string
}
