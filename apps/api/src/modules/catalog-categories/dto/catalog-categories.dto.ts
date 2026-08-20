import type { CatalogDomain } from '@manyfold/shared'
import {
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    MaxLength,
    Min
} from 'class-validator'

export class CreateCatalogCategoryDto {
    @IsIn(['skill', 'mcp'])
    domain!: CatalogDomain

    @IsString()
    @MaxLength(120)
    name!: string

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number
}

export class UpdateCatalogCategoryDto {
    @IsOptional()
    @IsString()
    @MaxLength(120)
    name?: string

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number
}
