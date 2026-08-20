import { agentModelConfigSources } from '@manyfold/shared'
import type {
    AgentModelConfig,
    AgentModelConfigSource,
    RefreshAgentModelConfigModelsBody,
    UpdateAgentModelConfigBody
} from '@manyfold/shared'
import { Transform } from 'class-transformer'
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

export class UpdateAgentModelConfigDto implements UpdateAgentModelConfigBody {
    @IsOptional()
    @IsIn(agentModelConfigSources)
    modelConfigSource?: AgentModelConfigSource

    @Transform(({ value }) => {
        if (value === null) return null
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length > 0 ? trimmed : null
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    model?: string | null

    @IsOptional()
    modelConfig?: AgentModelConfig | null
}

export class RefreshAgentModelConfigModelsDto implements RefreshAgentModelConfigModelsBody {
    @IsOptional()
    @IsIn(agentModelConfigSources)
    source?: AgentModelConfigSource
}
