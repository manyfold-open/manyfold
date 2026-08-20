import {
    IsObject,
    IsOptional,
    IsString,
    Length,
    MaxLength
} from 'class-validator'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

export class UpdateAgentDto {
    @IsOptional()
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name?: string

    @IsOptional()
    @IsString()
    @Length(1, 255)
    model?: string | null

    @IsOptional()
    @IsString()
    @MaxLength(65_536)
    envText?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    githubConnectionId?: string | null

    @IsOptional()
    @IsString()
    @Length(1, 64)
    cloudflareConnectionId?: string | null

    @IsOptional()
    @IsString()
    @Length(1, 64)
    composioConnectionId?: string | null

    // Per-scope MCP config (scopeId -> raw native text). Inner values are
    // validated in AgentsService against the agent's framework + scopes and
    // parsed for well-formedness.
    @IsOptional()
    @IsObject()
    mcp?: Record<string, string>
}
