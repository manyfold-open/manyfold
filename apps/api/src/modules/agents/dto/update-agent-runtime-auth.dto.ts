import type { UpdateAgentRuntimeAuthBody } from '@manyfold/shared'
import {
    IsDefined,
    IsIn,
    IsInt,
    IsOptional,
    Matches,
    Min,
    ValidateIf
} from 'class-validator'

const PROFILE_ID_RE = /^rap_[a-z2-7]{26}$/

export class UpdateAgentRuntimeAuthDto implements UpdateAgentRuntimeAuthBody {
    @IsDefined()
    @ValidateIf((_, value) => value !== null)
    @Matches(PROFILE_ID_RE)
    profileId!: string | null

    @IsInt()
    @Min(0)
    expectedBindingVersion!: number

    @IsOptional()
    @IsIn(['runtime-local'])
    modelConfigSource?: 'runtime-local'
}
