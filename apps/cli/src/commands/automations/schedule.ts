import {
    AUTOMATION_DEFAULT_TIME,
    AUTOMATION_SCHEDULE_PRESETS,
    automationPresetRrule,
    automationRruleTime,
    automationRruleWeekday,
    type AutomationSchedulePreset,
    type AutomationWeekday
} from '@manyfold/shared'
import { UsageError } from '@/usage-error'

// When an automation runs, from the flags people pass: a preset, an --rrule,
// or both, the way the web's schedule picker builds them.

export interface ScheduleFlags {
    schedulePreset?: string
    rrule?: string
    at?: string
    day?: string
}

export interface Schedule {
    schedulePreset: AutomationSchedulePreset
    rrule: string
}

// This machine's zone, as the web's picker takes the browser's.
export const localTimezone = (): string =>
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

const isPreset = (value: string): value is AutomationSchedulePreset =>
    (AUTOMATION_SCHEDULE_PRESETS as readonly string[]).includes(value)

const parseAt = (value: string): string => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
        throw new UsageError(
            `--at takes a time of day as HH:MM on a 24-hour clock, such as 09:00 or 17:30; got ${value}`
        )
    return `${match[1].padStart(2, '0')}:${match[2]}`
}

const DAYS: Record<string, AutomationWeekday> = {
    mo: 'MO',
    mon: 'MO',
    monday: 'MO',
    tu: 'TU',
    tue: 'TU',
    tuesday: 'TU',
    we: 'WE',
    wed: 'WE',
    wednesday: 'WE',
    th: 'TH',
    thu: 'TH',
    thursday: 'TH',
    fr: 'FR',
    fri: 'FR',
    friday: 'FR',
    sa: 'SA',
    sat: 'SA',
    saturday: 'SA',
    su: 'SU',
    sun: 'SU',
    sunday: 'SU'
}

const parseDay = (value: string): AutomationWeekday => {
    const day = DAYS[value.trim().toLowerCase()]
    if (!day)
        throw new UsageError(
            `--day takes a weekday: mon … sun (or MO … SU); got ${value}`
        )
    return day
}

// The schedule the flags ask for, or null when none of them is given. A
// preset gives its rule, at --at and, weekly, on --day; an --rrule alone is
// a custom schedule; both are taken as given. On an update what --at and
// --day leave out stays as the current rule has it, and either alone
// re-times the automation's own preset.
export const resolveSchedule = (
    flags: ScheduleFlags,
    current?: Schedule
): Schedule | null => {
    const { rrule, at, day } = flags
    const preset = flags.schedulePreset
    if (preset !== undefined && !isPreset(preset))
        throw new UsageError(
            `--schedule-preset takes ${AUTOMATION_SCHEDULE_PRESETS.join(', ')}; got ${preset}`
        )
    if (rrule !== undefined) {
        if (at !== undefined || day !== undefined)
            throw new UsageError(
                '--at and --day time a preset; an --rrule carries its own time'
            )
        return { schedulePreset: preset ?? 'custom', rrule }
    }
    if (preset === undefined && at === undefined && day === undefined)
        return null
    const base = preset ?? current?.schedulePreset
    if (!base)
        throw new UsageError(
            '--at and --day go with --schedule-preset hourly, daily, weekdays or weekly'
        )
    if (base === 'custom')
        throw new UsageError(
            preset
                ? '--schedule-preset custom needs its --rrule'
                : 'this automation runs on a custom --rrule: pass a new --rrule, or a --schedule-preset with --at'
        )
    if (day !== undefined && base !== 'weekly')
        throw new UsageError('--day goes with --schedule-preset weekly')
    const from = current?.rrule
    return {
        schedulePreset: base,
        rrule: automationPresetRrule(
            base,
            at !== undefined
                ? parseAt(at)
                : from
                  ? automationRruleTime(from)
                  : AUTOMATION_DEFAULT_TIME,
            day !== undefined
                ? parseDay(day)
                : from
                  ? automationRruleWeekday(from)
                  : 'MO'
        )
    }
}

const DAY_NAMES: Record<AutomationWeekday, string> = {
    MO: 'Monday',
    TU: 'Tuesday',
    WE: 'Wednesday',
    TH: 'Thursday',
    FR: 'Friday',
    SA: 'Saturday',
    SU: 'Sunday'
}

// "daily at 09:00", "weekly on Friday at 18:00", "hourly at :15".
export const describeSchedule = (schedule: Schedule): string => {
    const { schedulePreset: preset, rrule } = schedule
    const time = automationRruleTime(rrule)
    if (preset === 'hourly') return `hourly at :${time.slice(3)}`
    if (preset === 'daily') return `daily at ${time}`
    if (preset === 'weekdays') return `weekdays at ${time}`
    if (preset === 'weekly')
        return `weekly on ${DAY_NAMES[automationRruleWeekday(rrule)]} at ${time}`
    return `custom: ${rrule.replace(/^RRULE:/i, '')}`
}

// An instant as YYYY-MM-DD HH:MM on the clock of `timeZone`.
export const clockIn = (iso: string, timeZone: string): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(new Date(iso))
    const part = (type: string): string =>
        parts.find((entry) => entry.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
}
