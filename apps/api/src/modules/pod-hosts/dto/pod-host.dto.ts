import type {
    CliUpgradeBody,
    CreatePodHostBody,
    RenameBody
} from '@manyfold/shared'
import { IsOptional, IsString, Length } from 'class-validator'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

export class CreatePodHostDto implements CreatePodHostBody {
    @IsOptional()
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    clusterId?: string
}

export class RenamePodHostDto implements RenameBody {
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name!: string
}

export class PodHostCliUpgradeDto implements CliUpgradeBody {
    @IsOptional()
    @IsString()
    @Length(1, 64)
    targetVersion?: string
}
