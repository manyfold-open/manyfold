import {
    ArrayMaxSize,
    IsArray,
    IsOptional,
    IsString,
    MaxLength,
    ValidateNested
} from 'class-validator'
import { Type } from 'class-transformer'

export class ChannelSendFileDto {
    @IsString()
    @MaxLength(1024)
    path!: string
}

// Deliberately no toUserId and no reply credential. The agent names the room
// its turn came from; Manyfold resolves who that addresses and refuses a room
// with no inbound history. Handing the agent a target field would put the
// choice of recipient back inside the model.
export class ChannelSendDto {
    @IsString()
    @MaxLength(64)
    runtimeId!: string

    @IsString()
    @MaxLength(128)
    agentId!: string

    @IsString()
    @MaxLength(32)
    provider!: string

    @IsString()
    @MaxLength(512)
    roomId!: string

    @IsOptional()
    @IsString()
    @MaxLength(64_000)
    text?: string

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(4)
    @ValidateNested({ each: true })
    @Type(() => ChannelSendFileDto)
    attachments?: ChannelSendFileDto[]

    @IsOptional()
    @IsString()
    @MaxLength(128)
    idempotencyKey?: string
}
