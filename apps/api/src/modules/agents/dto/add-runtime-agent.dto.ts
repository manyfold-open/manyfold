import { Transform } from 'class-transformer'
import { IsOptional, IsString, Length, Matches } from 'class-validator'
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
}
