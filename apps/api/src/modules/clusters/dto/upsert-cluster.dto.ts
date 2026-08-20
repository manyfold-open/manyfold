import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator'

export class UpsertClusterDto {
    @IsString()
    @Length(1, 64)
    name!: string

    @IsOptional()
    @IsString()
    @Length(0, 512)
    description?: string

    @IsOptional()
    @IsString()
    @Length(0, 255)
    hostSuffix?: string

    @IsOptional()
    @IsString()
    @Length(0, 64)
    region?: string

    @IsOptional()
    @IsString()
    @Length(0, 65_536)
    kubeconfig?: string

    @IsOptional()
    @IsInt()
    @Min(-1000)
    @Max(1000)
    priority?: number
}
