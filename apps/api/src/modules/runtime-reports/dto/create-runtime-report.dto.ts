import { IsIn, IsString, Matches, MaxLength } from 'class-validator'

export class CreateRuntimeReportDto {
    @IsString()
    @MaxLength(64)
    runtimeId!: string

    @Matches(/^[a-f0-9]{12}$/)
    generation!: string

    @IsIn(['starting', 'ready'])
    event!: 'starting' | 'ready'
}
