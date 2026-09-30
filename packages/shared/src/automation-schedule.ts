import type { AutomationSchedulePreset } from './dtos'

// The rules the schedule presets stand for, shared by the web's picker and
// the CLI so that a preset means one RRULE wherever it is picked.

export const AUTOMATION_SCHEDULE_PRESETS: readonly AutomationSchedulePreset[] =
    ['hourly', 'daily', 'weekdays', 'weekly', 'custom']

export const AUTOMATION_WEEKDAYS = [
    'MO',
    'TU',
    'WE',
    'TH',
    'FR',
    'SA',
    'SU'
] as const
export type AutomationWeekday = (typeof AUTOMATION_WEEKDAYS)[number]

export const AUTOMATION_DEFAULT_TIME = '09:00'

const clamp = (value: number, min: number, max: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min

const parseTime = (time: string): { hour: number; minute: number } => {
    const [hourRaw, minuteRaw] = time.split(':')
    return {
        hour: clamp(Number(hourRaw), 0, 23),
        minute: clamp(Number(minuteRaw), 0, 59)
    }
}

const rruleValue = (rrule: string, key: string): string | null =>
    rrule.match(new RegExp(`(?:^|;)${key}=([^;]+)`, 'i'))?.[1] ?? null

// The rule a preset stands for at `time` (HH:MM; hourly runs at its minute)
// and, weekly, on `weekday`. Daily for anything else, custom included,
// which has no rule of its own.
export const automationPresetRrule = (
    preset: AutomationSchedulePreset,
    time: string,
    weekday: string
): string => {
    const { hour, minute } = parseTime(time)
    if (preset === 'hourly')
        return `RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=${minute};BYSECOND=0`
    if (preset === 'weekdays')
        return `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
    if (preset === 'weekly')
        return `RRULE:FREQ=WEEKLY;BYDAY=${weekday};BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
    return `RRULE:FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute};BYSECOND=0`
}

// A rule's time of day as HH:MM, 09:00 where it names none.
export const automationRruleTime = (rrule: string): string => {
    const hour = Number(rruleValue(rrule, 'BYHOUR') ?? 9)
    const minute = Number(rruleValue(rrule, 'BYMINUTE') ?? 0)
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// A rule's first weekday, Monday where it names none this knows.
export const automationRruleWeekday = (rrule: string): AutomationWeekday => {
    const first = (rruleValue(rrule, 'BYDAY') ?? 'MO').split(',')[0] ?? 'MO'
    return (AUTOMATION_WEEKDAYS as readonly string[]).includes(first)
        ? (first as AutomationWeekday)
        : 'MO'
}
