import type { McpCatalogTransport } from '@manyfold/shared'
import {
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    ValidateIf
} from 'class-validator'

const SERVER_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class CreateUserMcpServerDto {
    @Matches(SERVER_KEY_RE)
    serverKey!: string

    @IsString()
    @MaxLength(120)
    name!: string

    @IsOptional()
    @IsString()
    @MaxLength(1000)
    description?: string

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
    @MaxLength(1000, { each: true })
    args?: string[]

    @IsOptional()
    @IsObject()
    env?: Record<string, string>
}

export class UpdateUserMcpServerDto {
    @IsOptional()
    @Matches(SERVER_KEY_RE)
    serverKey?: string

    @IsOptional()
    @IsString()
    @MaxLength(120)
    name?: string

    @IsOptional()
    @ValidateIf((body) => body.description !== null)
    @IsString()
    @MaxLength(1000)
    description?: string | null

    @IsOptional()
    @IsIn(['http', 'stdio'])
    transport?: McpCatalogTransport

    @IsOptional()
    @ValidateIf((body) => body.url !== null)
    @IsString()
    @MaxLength(1000)
    url?: string | null

    @IsOptional()
    @ValidateIf((body) => body.headers !== null)
    @IsObject()
    headers?: Record<string, string> | null

    @IsOptional()
    @ValidateIf((body) => body.command !== null)
    @IsString()
    @MaxLength(255)
    command?: string | null

    @IsOptional()
    @ValidateIf((body) => body.args !== null)
    @IsArray()
    @IsString({ each: true })
    @MaxLength(1000, { each: true })
    args?: string[] | null

    @IsOptional()
    @ValidateIf((body) => body.env !== null)
    @IsObject()
    env?: Record<string, string> | null
}
