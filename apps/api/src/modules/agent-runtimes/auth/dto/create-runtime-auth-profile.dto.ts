import { RUNTIME_AUTH_METHODS, type RuntimeAuthMethod } from '@manyfold/shared'
import type { CreateRuntimeAuthProfileBody } from '@manyfold/shared'
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

export class CreateRuntimeAuthProfileDto implements CreateRuntimeAuthProfileBody {
    @IsOptional()
    @IsString()
    @MaxLength(80)
    label?: string

    @IsIn(RUNTIME_AUTH_METHODS)
    authMethod!: RuntimeAuthMethod

    @IsOptional()
    @IsString()
    @MaxLength(100)
    requestId?: string
}
