import type { RuntimeAuthOperationBody } from '@manyfold/shared'
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator'

export class RuntimeAuthOperationDto implements RuntimeAuthOperationBody {
    @IsOptional()
    @IsString()
    @MaxLength(100)
    requestId?: string

    @IsOptional()
    @IsBoolean()
    wake?: boolean
}
