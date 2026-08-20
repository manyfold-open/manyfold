import type { RenameBody } from '@manyfold/shared'
import { IsString } from 'class-validator'
import {
    IsAgentName,
    NormalizeAgentName
} from '@/modules/agents/dto/agent-name.dto'

export class RenameRuntimeDto implements RenameBody {
    @NormalizeAgentName()
    @IsString()
    @IsAgentName()
    name!: string
}