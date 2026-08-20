import type {
    AutomationDeliveryTarget,
    AutomationSchedulePreset,
    AutomationStatus,
    CreateAutomationBody,
    UpdateAutomationBody
} from '@manyfold/shared'
import { Transform } from 'class-transformer'
import {
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    Length,
    MaxLength
} from 'class-validator'

const trimString = (value: unknown): unknown =>
    typeof value === 'string' ? value.trim() : value

const nullableTrimmedString = (value: unknown): unknown => {
    const trimmed = trimString(value)
    return trimmed === '' ? null : trimmed
}

const automationStatuses: AutomationStatus[] = ['active', 'paused']
const schedulePresets: AutomationSchedulePreset[] = [
    'hourly',
    'daily',
    'weekdays',
    'weekly',
    'custom'
]

export class CreateAutomationDto implements CreateAutomationBody {
    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 120)
    agentId!: string

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 200)
    title!: string

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 32000)
    prompt!: string

    @IsIn(schedulePresets)
    schedulePreset!: AutomationSchedulePreset

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 2000)
    rrule!: string

    @Transform(({ value }) => trimString(value))
    @IsString()
    @Length(1, 100)
    timezone!: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @MaxLength(80)
    dtstart?: string

    @Transform(({ value }) => nullableTrimmedString(value))
    @IsOptional()
    @IsString()
    @MaxLength(255)
    model?: string | null

    @Transform(({ value }) => nullableTrimmedString(value))
    @IsOptional()
    @IsString()
    @MaxLength(120)
    deliveryChannelId?: string | null

    // Shape ({kind: 'chat'|'user', id} or {kind: 'scope', scopeKey}) is
    // validated in the service together with channel ownership and provider
    // capability.
    @IsOptional()
    @IsObject()
    deliveryTarget?: AutomationDeliveryTarget | null
}

export class UpdateAutomationDto implements UpdateAutomationBody {
    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 120)
    agentId?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 200)
    title?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 32000)
    prompt?: string

    @IsOptional()
    @IsIn(automationStatuses)
    status?: AutomationStatus

    @IsOptional()
    @IsIn(schedulePresets)
    schedulePreset?: AutomationSchedulePreset

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 2000)
    rrule?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @Length(1, 100)
    timezone?: string

    @Transform(({ value }) => trimString(value))
    @IsOptional()
    @IsString()
    @MaxLength(80)
    dtstart?: string

    @Transform(({ value }) => nullableTrimmedString(value))
    @IsOptional()
    @IsString()
    @MaxLength(255)
    model?: string | null

    @Transform(({ value }) => nullableTrimmedString(value))
    @IsOptional()
    @IsString()
    @MaxLength(120)
    deliveryChannelId?: string | null

    @IsOptional()
    @IsObject()
    deliveryTarget?: AutomationDeliveryTarget | null
}
