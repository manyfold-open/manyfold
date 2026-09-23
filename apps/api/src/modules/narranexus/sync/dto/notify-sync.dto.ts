import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

export class NotifySyncDto {
    @IsString()
    @MaxLength(64)
    runtimeId!: string

    // Advisory only: the reconciler always pulls both kinds, since the pull
    // itself is the source of truth and the sandbox is already awake.
    @IsOptional()
    @IsArray()
    @IsIn(['jobs', 'channels'], { each: true })
    kinds?: ('jobs' | 'channels')[]
}
