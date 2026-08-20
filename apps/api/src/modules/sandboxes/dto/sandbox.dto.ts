import type {
    CliUpgradeBody,
    CreateSandboxBody,
    RenameBody,
    SetSandboxTerminalBody
} from '@manyfold/shared'
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

export class CreateSandboxDto implements CreateSandboxBody {
    @IsOptional()
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name?: string

    @IsOptional()
    @IsString()
    @Length(1, 64)
    accountId?: string
}

export class SetSandboxTerminalDto implements SetSandboxTerminalBody {
    @IsBoolean()
    enabled!: boolean
}

export class RenameSandboxDto implements RenameBody {
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name!: string
}

export class CliUpgradeDto implements CliUpgradeBody {
    @IsOptional()
    @IsString()
    @Length(1, 64)
    targetVersion?: string
}
