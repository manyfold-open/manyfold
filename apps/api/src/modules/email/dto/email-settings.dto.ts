import type {
    EmailProviderKind,
    SendTestEmailBody,
    UpdateEmailProviderSettingsBody
} from '@manyfold/shared'
import {
    IsBoolean,
    IsEmail,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    Max,
    Min
} from 'class-validator'

export class UpdateEmailProviderSettingsDto
    implements UpdateEmailProviderSettingsBody
{
    @IsIn(['console', 'resend', 'smtp'])
    provider!: EmailProviderKind

    @IsOptional()
    @IsString()
    resendApiKey?: string

    @IsOptional()
    @IsString()
    resendFrom?: string

    @IsOptional()
    @IsString()
    resendReplyTo?: string | null

    @IsOptional()
    @IsString()
    smtpHost?: string

    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(65_535)
    smtpPort?: number

    @IsOptional()
    @IsBoolean()
    smtpSecure?: boolean

    @IsOptional()
    @IsString()
    smtpUsername?: string | null

    @IsOptional()
    @IsString()
    smtpPassword?: string

    @IsOptional()
    @IsString()
    smtpFrom?: string

    @IsOptional()
    @IsString()
    smtpReplyTo?: string | null
}

export class SendTestEmailDto implements SendTestEmailBody {
    @IsEmail()
    to!: string
}
