import { IsOptional, IsString, Length } from 'class-validator'

export class CreateCloudflareConnectionDto {
    @IsString()
    @Length(8, 4096)
    token!: string

    @IsOptional()
    @IsString()
    @Length(0, 128)
    name?: string

    @IsOptional()
    @IsString()
    @Length(0, 64)
    accountId?: string
}

export class CreateComposioConnectionDto {
    @IsString()
    @Length(8, 4096)
    apiKey!: string

    @IsOptional()
    @IsString()
    @Length(0, 128)
    name?: string
}

export class RenameConnectionDto {
    @IsString()
    @Length(1, 128)
    name!: string
}
