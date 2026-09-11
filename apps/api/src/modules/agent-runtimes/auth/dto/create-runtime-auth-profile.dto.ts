import { RUNTIME_AUTH_METHODS, type RuntimeAuthMethod } from '@manyfold/shared'
import type { CreateRuntimeAuthProfileBody } from '@manyfold/shared'
import {
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    MaxLength,
    MinLength
} from 'class-validator'

export class CreateRuntimeAuthProfileDto implements CreateRuntimeAuthProfileBody {
    @IsOptional()
    @IsString()
    @MaxLength(80)
    label?: string

    @IsIn(RUNTIME_AUTH_METHODS)
    authMethod!: RuntimeAuthMethod

    // Forwarded to the host once; never stored or logged by the API.
    @IsOptional()
    @IsString()
    @MinLength(10)
    @MaxLength(4096)
    apiKey?: string

    @IsOptional()
    @IsString()
    @MaxLength(100)
    requestId?: string

    @IsOptional()
    @IsBoolean()
    wake?: boolean
}
