import {
    BUILT_IN_PROVIDER_IDS,
    INFERENCE_PROTOCOLS,
    InferenceProtocol,
    ProtocolModelMap,
    inputValidation
} from '@manyfold/shared'
import {
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Length,
    Matches,
    ValidateIf
} from 'class-validator'

const INFERENCE_PROTOCOL_VALUES: InferenceProtocol[] = [
    ...INFERENCE_PROTOCOLS
]
const BUILT_IN_IDS: string[] = [...BUILT_IN_PROVIDER_IDS]

export class CreateUserModelProviderDto {
    @IsString()
    @IsIn(INFERENCE_PROTOCOL_VALUES)
    inferenceProtocol!: InferenceProtocol

    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    providerName!: string

    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey!: string

    @IsString()
    @Length(1, 512)
    baseUrl!: string

    @IsOptional()
    @IsString()
    @Length(1, 512)
    modelsListUrl?: string
}

export class UpdateUserModelProviderDto {
    @IsOptional()
    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    providerName?: string

    @IsOptional()
    @IsString()
    @IsIn(INFERENCE_PROTOCOL_VALUES)
    inferenceProtocol?: InferenceProtocol

    @IsOptional()
    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey?: string

    @IsOptional()
    @IsString()
    @Length(0, 512)
    baseUrl?: string | null

    @IsOptional()
    @IsString()
    @Length(0, 512)
    modelsListUrl?: string | null

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsObject()
    enabledModels?: ProtocolModelMap | null
}

export class CreateBuiltInUserModelProviderDto {
    @IsString()
    @IsIn(BUILT_IN_IDS)
    builtInId!: string

    @IsOptional()
    @IsString()
    @Length(
        inputValidation.USER_MODEL_PROVIDER_LABEL.MIN,
        inputValidation.USER_MODEL_PROVIDER_LABEL.MAX
    )
    @Matches(/^[A-Za-z0-9][A-Za-z0-9_\- .]*$/)
    providerName?: string

    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey!: string
}

export class TestInlineProviderDto {
    @IsString()
    @IsIn(INFERENCE_PROTOCOL_VALUES)
    inferenceProtocol!: InferenceProtocol

    @IsString()
    @Length(
        inputValidation.MODEL_PROVIDER_API_KEY.MIN,
        inputValidation.MODEL_PROVIDER_API_KEY.MAX
    )
    apiKey!: string

    @IsString()
    @Length(1, 512)
    baseUrl!: string

    @IsOptional()
    @IsString()
    @Length(0, 512)
    modelsListUrl?: string | null
}
