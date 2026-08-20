import type { CliUpgradeBody } from '@manyfold/shared'
import { IsOptional, IsString, Length } from 'class-validator'

export class CliUpgradeDto implements CliUpgradeBody {
    @IsOptional()
    @IsString()
    @Length(1, 64)
    targetVersion?: string
}
