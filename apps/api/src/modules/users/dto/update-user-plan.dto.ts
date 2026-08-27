import type { PlanId, UpdateUserPlanBody } from '@manyfold/shared'
import { IsString, MaxLength, MinLength } from 'class-validator'

export class UpdateUserPlanDto implements UpdateUserPlanBody {
    // Plan ids are rows, not an enum (operators may seed their own), so the
    // service checks existence instead of a class-validator whitelist.
    @IsString()
    @MinLength(1)
    @MaxLength(64)
    planId!: PlanId
}
