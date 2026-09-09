import { Transform } from 'class-transformer'
import {
    IsIn,
    IsOptional,
    IsString,
    Length,
    Matches,
    ValidateIf
} from 'class-validator'
import {
    agentModelConfigSources,
    type AgentModelConfigSource
} from '@manyfold/shared'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

const BlankToUndefined = () =>
    Transform(({ value }) => {
        if (typeof value !== 'string') return value
        const trimmed = value.trim()
        return trimmed.length === 0 ? undefined : trimmed
    })

export class AddRuntimeAgentDto {
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name!: string

    @BlankToUndefined()
    @IsOptional()
    @IsString()
    @Length(1, 1024)
    @Matches(/^\//, { message: 'workspace must be an absolute path' })
    @Matches(/^[^\0]+$/, { message: 'workspace must not contain NUL' })
    workspace?: string

    @IsOptional()
    @IsString()
    @Length(1, 128)
    model?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    cloneFrom?: string

    // The wizard's auth choice for an agent joining an existing runtime: the
    // source it picked and, for runtime-local, which of the runtime's auth
    // profiles to bind (null = the host's own sign-in).
    @IsOptional()
    @IsIn(agentModelConfigSources)
    modelConfigSource?: AgentModelConfigSource

    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @Matches(/^rap_[a-z2-7]{26}$/)
    runtimeAuthProfileId?: string | null
}
