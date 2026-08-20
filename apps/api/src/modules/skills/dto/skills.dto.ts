import type { LibrarySkillImportConflict } from '@manyfold/shared'
import {
    ArrayMaxSize,
    ArrayNotEmpty,
    IsArray,
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    Length,
    Matches,
    MaxLength,
    ValidateIf
} from 'class-validator'

export class UpdateSkillCurationDto {
    @IsOptional()
    @ValidateIf((o) => o.categoryId !== null)
    @IsString()
    categoryId?: string | null

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags?: string[]

    @IsOptional()
    @IsBoolean()
    featured?: boolean

    @IsOptional()
    @IsBoolean()
    hidden?: boolean
}

export class InstallSkillDto {
    @IsString()
    @Length(1, 700)
    skillId!: string

    @IsString()
    @Length(1, 120)
    agentId!: string
}

export class InstallSkillBatchDto {
    @IsString()
    @Length(1, 700)
    skillId!: string

    @IsArray()
    @ArrayNotEmpty()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 120, { each: true })
    agentIds!: string[]
}

export class PushLibrarySkillDto {
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Length(1, 120, { each: true })
    agentIds?: string[]
}

export class UpdateUserSkillDto {
    @IsBoolean()
    enabled!: boolean
}

export class CreateSkillRepoDto {
    @IsString()
    @Length(1, 100)
    @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/)
    owner!: string

    @IsString()
    @Length(1, 100)
    @Matches(/^[A-Za-z0-9._-]+$/)
    name!: string

    @IsOptional()
    @IsString()
    @Length(1, 200)
    @Matches(/^[A-Za-z0-9._/-]+$/)
    branch?: string
}

export class UpdateSkillRepoDto {
    @IsOptional()
    @IsString()
    @Length(1, 200)
    @Matches(/^[A-Za-z0-9._/-]+$/)
    branch?: string

    @IsOptional()
    @IsBoolean()
    enabled?: boolean
}

// Content caps are re-checked in bytes by LibrarySkillsService; the MaxLength
// here is only a fast pre-filter (UTF-16 code units).
export class CreateLibrarySkillDto {
    @IsString()
    @Length(1, 100)
    name!: string

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string

    @IsOptional()
    @IsString()
    @MaxLength(1_048_576)
    content?: string
}

export class UpdateLibrarySkillDto {
    @IsOptional()
    @IsString()
    @Length(1, 100)
    name?: string

    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string

    @IsOptional()
    @IsString()
    @MaxLength(1_048_576)
    content?: string
}

export class UpsertLibrarySkillFileDto {
    @IsString()
    @Length(1, 512)
    path!: string

    @IsString()
    @MaxLength(1_048_576)
    content!: string
}

export class ImportLibrarySkillDto {
    @IsOptional()
    @IsString()
    @Length(1, 2000)
    url?: string

    @IsOptional()
    @IsString()
    @Length(1, 700)
    catalogSkillId?: string

    @IsOptional()
    @IsString()
    @Length(1, 100)
    shareId?: string

    @IsOptional()
    @IsIn(['fail', 'overwrite', 'rename'])
    onConflict?: LibrarySkillImportConflict
}
