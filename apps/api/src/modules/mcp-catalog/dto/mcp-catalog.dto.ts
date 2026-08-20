import type { McpCatalogTransport } from '@manyfold/shared'
import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    Min,
    ValidateIf
} from 'class-validator'

// slug becomes the MCP server key in agent configs (TOML table name), so no dots.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class CreateMcpCatalogEntryDto {
    @Matches(SLUG_RE)
    slug!: string

    @IsString()
    @MaxLength(120)
    name!: string

    @IsString()
    @MaxLength(1000)
    description!: string

    @IsString()
    @MaxLength(1000)
    homepageUrl!: string

    @IsIn(['http', 'stdio'])
    transport!: McpCatalogTransport

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    url?: string

    @IsOptional()
    @IsObject()
    headers?: Record<string, string>

    @IsOptional()
    @IsString()
    @MaxLength(255)
    command?: string

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    args?: string[]

    @IsOptional()
    @IsObject()
    env?: Record<string, string>

    @IsOptional()
    @IsString()
    @MaxLength(50000)
    longDescription?: string

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    iconUrl?: string

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags?: string[]

    @IsOptional()
    @ValidateIf((o) => o.categoryId !== null)
    @IsString()
    categoryId?: string | null

    @IsOptional()
    @IsBoolean()
    featured?: boolean

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean
}

export class UpdateMcpCatalogEntryDto {
    @IsOptional()
    @Matches(SLUG_RE)
    slug?: string

    @IsOptional()
    @IsString()
    @MaxLength(120)
    name?: string

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    description?: string

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    homepageUrl?: string

    @IsOptional()
    @IsIn(['http', 'stdio'])
    transport?: McpCatalogTransport

    @IsOptional()
    @ValidateIf((o) => o.url !== null)
    @IsString()
    @MaxLength(1000)
    url?: string | null

    @IsOptional()
    @ValidateIf((o) => o.headers !== null)
    @IsObject()
    headers?: Record<string, string> | null

    @IsOptional()
    @ValidateIf((o) => o.command !== null)
    @IsString()
    @MaxLength(255)
    command?: string | null

    @IsOptional()
    @ValidateIf((o) => o.args !== null)
    @IsArray()
    @IsString({ each: true })
    args?: string[] | null

    @IsOptional()
    @ValidateIf((o) => o.env !== null)
    @IsObject()
    env?: Record<string, string> | null

    @IsOptional()
    @ValidateIf((o) => o.longDescription !== null)
    @IsString()
    @MaxLength(50000)
    longDescription?: string | null

    @IsOptional()
    @ValidateIf((o) => o.iconUrl !== null)
    @IsString()
    @MaxLength(1000)
    iconUrl?: string | null

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    @MaxLength(40, { each: true })
    tags?: string[]

    @IsOptional()
    @ValidateIf((o) => o.categoryId !== null)
    @IsString()
    categoryId?: string | null

    @IsOptional()
    @IsBoolean()
    featured?: boolean

    @IsOptional()
    @IsInt()
    @Min(0)
    sortOrder?: number

    @IsOptional()
    @IsBoolean()
    isActive?: boolean
}
