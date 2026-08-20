import type {
    CreateNotificationWebhookBody,
    NotificationEventKey,
    NotificationProvider,
    UpdateNotificationWebhookBody
} from '@manyfold/shared'
import {
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    IsUrl,
    Length
} from 'class-validator'

const PROVIDERS = ['slack', 'discord', 'lark', 'telegram'] as const

const EVENT_KEYS = [
    'user.registered',
    'subscription.activated',
    'payment.credited'
] as const

export class CreateNotificationWebhookDto
    implements CreateNotificationWebhookBody
{
    @IsIn(PROVIDERS as unknown as string[])
    provider!: NotificationProvider

    @IsString()
    @Length(1, 80)
    label!: string

    @IsOptional()
    @IsBoolean()
    enabled?: boolean

    @IsArray()
    @ArrayMinSize(1)
    @IsIn(EVENT_KEYS as unknown as string[], { each: true })
    events!: NotificationEventKey[]

    @IsOptional()
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
    webhookUrl?: string

    @IsOptional()
    @IsString()
    larkSecret?: string

    @IsOptional()
    @IsString()
    botToken?: string

    @IsOptional()
    @IsString()
    chatId?: string
}

export class UpdateNotificationWebhookDto
    implements UpdateNotificationWebhookBody
{
    @IsOptional()
    @IsString()
    @Length(1, 80)
    label?: string

    @IsOptional()
    @IsBoolean()
    enabled?: boolean

    @IsOptional()
    @IsArray()
    @ArrayMinSize(1)
    @IsIn(EVENT_KEYS as unknown as string[], { each: true })
    events?: NotificationEventKey[]

    @IsOptional()
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
    webhookUrl?: string

    @IsOptional()
    @IsString()
    larkSecret?: string | null

    @IsOptional()
    @IsString()
    botToken?: string

    @IsOptional()
    @IsString()
    chatId?: string
}