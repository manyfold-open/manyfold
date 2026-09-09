import type { SetRuntimeDefaultAuthBody } from '@manyfold/shared'
import { IsDefined, Matches, ValidateIf } from 'class-validator'

const PROFILE_ID_RE = /^rap_[a-z2-7]{26}$/

export class SetRuntimeDefaultAuthDto implements SetRuntimeDefaultAuthBody {
    @IsDefined()
    @ValidateIf((_, value) => value !== null)
    @Matches(PROFILE_ID_RE)
    profileId!: string | null
}
