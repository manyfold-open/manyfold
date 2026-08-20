import { inputValidation } from '@manyfold/shared'
import {
    IsInt,
    IsOptional,
    IsString,
    Length,
    Matches,
    Max,
    Min
} from 'class-validator'

export class CreateSpritesAccountDto {
    @IsString()
    @Length(
        inputValidation.SPRITES_ACCOUNT_SLUG.MIN,
        inputValidation.SPRITES_ACCOUNT_SLUG.MAX
    )
    @Matches(/^[a-z0-9][a-z0-9_-]*$/)
    slug!: string

    @IsString()
    @Length(16, 256)
    token!: string

    @IsOptional()
    @IsString()
    @Length(0, 1024)
    notes?: string

    @IsOptional()
    @IsInt()
    @Min(-1000)
    @Max(1000)
    priority?: number
}

export class RotateSpritesAccountDto {
    @IsString()
    @Length(16, 256)
    token!: string
}

export class UpdateSpritesAccountDto {
    @IsOptional()
    @IsString()
    @Length(0, 1024)
    notes?: string | null

    @IsOptional()
    @IsInt()
    @Min(-1000)
    @Max(1000)
    priority?: number
}
