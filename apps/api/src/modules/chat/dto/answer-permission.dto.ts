import type { AnswerPermissionRequest } from '@manyfold/shared'
import { IsString, MaxLength, MinLength } from 'class-validator'

export class AnswerPermissionDto implements AnswerPermissionRequest {
    @IsString()
    @MinLength(1)
    @MaxLength(128)
    optionId!: string
}
