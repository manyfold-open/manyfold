import type {
    AgentChannelSendBody,
    ChannelConfig,
    ChannelCredentials,
    ChannelProviderName,
    ChannelStatus,
    CreateChannelBody,
    LarkAppRegion,
    StartLarkRegistrationBody,
    StartWeixinRegistrationBody,
    SubmitWeixinVerifyCodeBody,
    UpdateChannelBody
} from '@manyfold/shared'
import { Transform } from 'class-transformer'
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Length
} from 'class-validator'

const trimString = (value: unknown): unknown =>
    typeof value === 'string' ? value.trim() : value

const providerNames: ChannelProviderName[] = [
    'fake',
    'lark',
    'telegram',
    'slack',
    'discord',
    'matrix',
    'weixin',
    'linear',
    'github',
    'line'
]
const channelStatuses: ChannelStatus[] = ['draft', 'active', 'paused', 'error']
const larkAppRegions: LarkAppRegion[] = ['feishu', 'lark']

export class StartLarkRegistrationDto implements StartLarkRegistrationBody {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 120)
    agentId!: string

    @IsIn(larkAppRegions)
    appRegion!: LarkAppRegion

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 200)
    label!: string

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 60)
    botName!: string
}

export class StartWeixinRegistrationDto
    implements StartWeixinRegistrationBody
{
    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 120)
    agentId!: string

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 200)
    label!: string
}

export class SubmitWeixinVerifyCodeDto
    implements SubmitWeixinVerifyCodeBody
{
    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 32)
    verifyCode!: string
}

export class CreateChannelDto implements CreateChannelBody {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 120)
    agentId!: string

    @IsIn(providerNames)
    provider!: ChannelProviderName

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 200)
    label!: string

    @IsObject()
    config!: ChannelConfig

    @IsOptional()
    @IsObject()
    credentials?: ChannelCredentials | null
}

export class AgentChannelSendDto implements AgentChannelSendBody {
    @IsOptional()
    @IsString()
    @Length(1, 20000)
    text?: string

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(4)
    @IsString({ each: true })
    @Length(1, 500, { each: true })
    files?: string[]

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 200)
    chatId?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 200)
    userId?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 200)
    replyToMessageId?: string
}

export class UpdateChannelDto implements UpdateChannelBody {
    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 120)
    agentId?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 200)
    label?: string

    @IsOptional()
    @IsIn(channelStatuses)
    status?: ChannelStatus

    @IsOptional()
    @IsObject()
    config?: ChannelConfig

    @IsOptional()
    @IsObject()
    credentials?: ChannelCredentials | null
}
