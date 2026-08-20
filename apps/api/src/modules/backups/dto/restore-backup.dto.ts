import { IsString, Length } from 'class-validator'

export class RestoreBackupDto {
    @IsString()
    @Length(1, 64)
    backupId!: string
}
