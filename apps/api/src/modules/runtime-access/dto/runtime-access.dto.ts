import { IsInt, IsOptional, Max, Min } from 'class-validator'

export class UpdateUserRuntimeAccessDto {
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1000)
    statefulSandboxLimit?: number

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(1000)
    alwaysOnlineRuntimeBonus?: number

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10000)
    activeHoursBonus?: number
}
