import type {
    AuthSetupBody,
    OidcTokenSource,
    UpdateLoginProviderSettingsBody
} from '@manyfold/shared'
import {
    IsArray,
    IsBoolean,
    IsEmail,
    IsIn,
    IsOptional,
    IsString,
    MinLength
} from 'class-validator'

export class UpdateLoginProviderSettingsDto
    implements UpdateLoginProviderSettingsBody
{
    @IsBoolean()
    passwordEnabled!: boolean

    @IsBoolean()
    emailVerificationRequired!: boolean

    @IsBoolean()
    googleEnabled!: boolean

    @IsOptional()
    @IsString()
    googleClientId?: string

    @IsOptional()
    @IsString()
    googleClientSecret?: string

    @IsBoolean()
    oidcEnabled!: boolean

    @IsOptional()
    @IsString()
    oidcAuthority?: string

    @IsOptional()
    @IsString()
    oidcClientId?: string

    @IsOptional()
    @IsString()
    oidcClientSecret?: string

    @IsOptional()
    @IsString()
    oidcAudience?: string | null

    @IsOptional()
    @IsString()
    oidcScope?: string

    @IsOptional()
    @IsIn(['access_token', 'id_token'])
    oidcTokenSource?: OidcTokenSource

    @IsOptional()
    @IsString()
    oidcJwksUrl?: string | null

    @IsOptional()
    @IsString()
    oidcUserIdClaim?: string

    @IsOptional()
    @IsString()
    oidcEmailClaim?: string

    @IsOptional()
    @IsString()
    oidcButtonLabel?: string | null

    @IsOptional()
    @IsBoolean()
    netmindEnabled?: boolean

    @IsOptional()
    @IsString()
    netmindAuthApi?: string

    @IsOptional()
    @IsString()
    netmindAccountsUrl?: string

    @IsOptional()
    @IsString()
    netmindSysCode?: string

    @IsOptional()
    @IsString()
    netmindRegisterUrl?: string

    @IsOptional()
    @IsArray()
    @IsEmail({}, { each: true })
    initialAdminEmails?: string[]
}

export class AuthSetupDto
    extends UpdateLoginProviderSettingsDto
    implements AuthSetupBody
{
    @IsString()
    setupToken!: string

    // May be empty — the controller always includes adminEmail, so the stored
    // admin set is never empty even when this is omitted from the form.
    @IsArray()
    @IsEmail({}, { each: true })
    declare initialAdminEmails: string[]

    @IsEmail()
    adminEmail!: string

    @IsString()
    @MinLength(8)
    adminPassword!: string
}
