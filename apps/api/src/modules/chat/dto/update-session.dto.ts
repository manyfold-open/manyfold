import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator'

export class UpdateSessionDto {
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsString()
    @MaxLength(200)
    title?: string | null
}
