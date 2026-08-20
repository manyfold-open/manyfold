import { IsNotEmpty, IsString, Length } from 'class-validator'

export class UpgradeFrameworkVersionDto {
    @IsString()
    @IsNotEmpty()
    @Length(1, 64)
    targetVersion!: string
}
