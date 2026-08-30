import {
    AgentModelConfig,
    AgentModelConfigSource,
    CHAT_ATTACHMENT_MAX_COUNT,
    CHAT_ATTACHMENT_MAX_FILE_BYTES,
    CHAT_UPLOAD_MAX_COUNT,
    CHAT_UPLOAD_MAX_FILE_BYTES,
    ClaudeCodePermissionMode,
    CodexPermissionMode,
    HermesPermissionMode,
    CreateMessageAttachmentInput,
    CreateMessageContextRefInput,
    CreateMessageUploadInput,
    agentModelConfigSources,
    claudeCodePermissionModes,
    codexPermissionModes,
    hermesPermissionModes
} from '@manyfold/shared'
import { Transform, Type } from 'class-transformer'
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    MaxLength,
    Min,
    MinLength,
    Validate,
    ValidateNested,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
    type ValidationArguments
} from 'class-validator'

const trimString = (value: unknown): unknown =>
    typeof value === 'string' ? value.trim() : value

class CreateMessageAttachmentDto implements CreateMessageAttachmentInput {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    path!: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    rootId?: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    name?: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    contentType?: string

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(CHAT_ATTACHMENT_MAX_FILE_BYTES)
    size?: number
}

class CreateMessageContextRefDto implements CreateMessageContextRefInput {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @MinLength(1)
    @MaxLength(2048)
    path!: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    rootId?: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    name?: string

    @IsOptional()
    @IsIn(['file', 'dir'])
    entryType?: 'file' | 'dir'

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    contentType?: string

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(CHAT_ATTACHMENT_MAX_FILE_BYTES)
    size?: number
}

class CreateMessageUploadDto implements CreateMessageUploadInput {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    uploadId!: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    name?: string

    @Transform(({ value }) => {
        const trimmed = trimString(value)
        return trimmed === '' ? undefined : trimmed
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    contentType?: string

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(CHAT_UPLOAD_MAX_FILE_BYTES)
    size?: number
}

@ValidatorConstraint({ name: 'hasMessagePayload', async: false })
class HasMessagePayloadConstraint implements ValidatorConstraintInterface {
    validate(_value: unknown, args: ValidationArguments): boolean {
        const dto = args.object as CreateMessageDto
        const hasText =
            typeof dto.text === 'string' && dto.text.trim().length > 0
        const hasAttachments =
            Array.isArray(dto.attachments) && dto.attachments.length > 0
        const hasContextRefs =
            Array.isArray(dto.contextRefs) && dto.contextRefs.length > 0
        const hasUploads =
            Array.isArray(dto.uploads) && dto.uploads.length > 0
        return hasText || hasAttachments || hasContextRefs || hasUploads
    }

    defaultMessage(): string {
        return 'text, attachments, context refs, or uploads are required'
    }
}

export class CreateMessageDto {
    @Validate(HasMessagePayloadConstraint)
    readonly payload = true

    @Transform(({ value }) => (value === undefined ? undefined : value))
    @IsOptional()
    @IsString()
    @MaxLength(32000)
    text?: string

    @Transform(({ value }) => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : undefined
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    model?: string

    @IsOptional()
    @IsIn(agentModelConfigSources)
    modelConfigSource?: AgentModelConfigSource

    @IsOptional()
    modelConfig?: AgentModelConfig

    @IsOptional()
    @IsBoolean()
    saveAsDefault?: boolean

    @IsOptional()
    @IsIn(claudeCodePermissionModes)
    claudeCodePermissionMode?: ClaudeCodePermissionMode

    @IsOptional()
    @IsIn(codexPermissionModes)
    codexPermissionMode?: CodexPermissionMode

    @IsOptional()
    @IsIn(hermesPermissionModes)
    hermesPermissionMode?: HermesPermissionMode

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(CHAT_ATTACHMENT_MAX_COUNT)
    @ValidateNested({ each: true })
    @Type(() => CreateMessageAttachmentDto)
    attachments?: CreateMessageAttachmentDto[]

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(CHAT_ATTACHMENT_MAX_COUNT)
    @ValidateNested({ each: true })
    @Type(() => CreateMessageContextRefDto)
    contextRefs?: CreateMessageContextRefDto[]

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(CHAT_UPLOAD_MAX_COUNT)
    @ValidateNested({ each: true })
    @Type(() => CreateMessageUploadDto)
    uploads?: CreateMessageUploadDto[]
}

export class RegenerateMessageDto {
    @Transform(({ value }) => (value === undefined ? undefined : value))
    @IsOptional()
    @IsString()
    @MaxLength(32000)
    text?: string

    @Transform(({ value }) => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : undefined
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    model?: string

    @IsOptional()
    @IsIn(agentModelConfigSources)
    modelConfigSource?: AgentModelConfigSource

    @IsOptional()
    modelConfig?: AgentModelConfig

    @IsOptional()
    @IsBoolean()
    saveAsDefault?: boolean

    @IsOptional()
    @IsIn(codexPermissionModes)
    codexPermissionMode?: CodexPermissionMode
}

export class ListMessagesQueryDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    limit?: number

    @Transform(({ value }) => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : undefined
    })
    @IsOptional()
    @IsString()
    @MaxLength(512)
    before?: string
}
