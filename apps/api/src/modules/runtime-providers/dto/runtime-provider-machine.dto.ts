import {
    IsBoolean,
    IsOptional,
    IsString,
    Length,
    Matches
} from 'class-validator'

export class UpgradeProviderMachineDto {
    // A target build, for a rollback or a lane with nothing newer; none is
    // the newest build the provider offers the machine.
    @IsOptional()
    @IsString()
    @Length(1, 64)
    @Matches(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
    version?: string

    @IsOptional()
    @IsBoolean()
    allowStorageMigration?: boolean
}
