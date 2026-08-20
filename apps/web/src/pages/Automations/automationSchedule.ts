import { getLocale, t } from '@manyfold/i18n'
import type { AutomationSchedulePreset } from '@manyfold/shared'

export const schedulePresets: AutomationSchedulePreset[] = [
    'hourly',
    'daily',
    'weekdays',
    'weekly',
    'custom'
]

export const weekdayOptions = [
    { code: 'MO', labelKey: 'web.automations.monday' },
    { code: 'TU', labelKey: 'web.automations.tuesday' },
    { code: 'WE', labelKey: 'web.automations.wednesday' },
    { code: 'TH', labelKey: 'web.automations.thursday' },
    { code: 'FR', labelKey: 'web.automations.friday' },
    { code: 'SA', labelKey: 'web.automations.saturday' },
    { code: 'SU', labelKey: 'web.automations.sunday' }
]

export const timezone = (): string =>
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const defaultTime = '09:00'

export const buildPresetRrule = (
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

export const ensureRrulePrefix = (value: string): string => {
    const trimmed = value.trim()
    return /^RRULE:/i.test(trimmed) ? trimmed : `RRULE:${trimmed}`
}

export const scheduleLabel = (
    preset: AutomationSchedulePreset,
    rrule: string
): string => {
    if (preset === 'custom') return t('web.automations.custom')
    if (preset === 'hourly') return t('web.automations.hourly')
    const hour = Number(rruleValue(rrule, 'BYHOUR') ?? 9)
    const minute = Number(rruleValue(rrule, 'BYMINUTE') ?? 0)
    const time = formatLocalTime(hour, minute)
    if (preset === 'weekdays')
        return t('web.automations.weekdaysAt', { time })
    if (preset === 'weekly') {
        const byday = rruleValue(rrule, 'BYDAY') ?? 'MO'
        const day =
            weekdayOptions.find((option) => option.code === byday)?.labelKey ??
            'web.automations.monday'
        return t('web.automations.weeklyOn', { day: t(day), time })
    }
    return t('web.automations.dailyAt', { time })
}

const DAY_MS = 86400000

// "today" and "tomorrow" are calendar words, so the day boundary has to be
// drawn in the same zone the clock is printed in: an automation scheduled in
// Asia/Shanghai and read from London disagrees about which day it is.
const calendarDay = (date: Date, timeZone?: string): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date)
    const part = (type: string): number =>
        Number(parts.find((entry) => entry.type === type)?.value)
    return Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS
}

const calendarDaysUntil = (date: Date, timeZone?: string): number =>
    calendarDay(date, timeZone) - calendarDay(new Date(), timeZone)

const timeOfDay = (date: Date, timeZone?: string): string =>
    date.toLocaleTimeString(getLocale(), {
        timeZone,
        hour: 'numeric',
        minute: '2-digit'
    })

// The list surface answers "when does this run next", never "how long until"
// — a countdown expires the moment it renders and forces the reader to do
// arithmetic. `terse` drops the today qualifier for copy that already says
// "next". Times print in the automation's own zone when one is passed, so the
// clock agrees with the timezone the surface labels it with.
const formatUpcoming = (
    date: Date,
    terse: boolean,
    timeZone?: string
): string => {
    const time = timeOfDay(date, timeZone)
    const days = calendarDaysUntil(date, timeZone)
    if (days === 0) return terse ? time : t('web.automations.todayAt', { time })
    if (days === 1) return t('web.automations.tomorrowAt', { time })
    // A next occurrence in the past means the schedule is stale or overdue;
    // its date is the honest answer, where "today" would be wrong and a bare
    // weekday reads as the coming one.
    const day = date.toLocaleDateString(getLocale(), {
        timeZone,
        ...(days > 1 && days < 7
            ? { weekday: 'short' }
            : { month: 'short', day: 'numeric' })
    })
    return `${day}, ${time}`
}

export const formatNextRun = (
    value: string | null,
    timeZone?: string
): string =>
    value
        ? formatUpcoming(new Date(value), false, timeZone)
        : t('web.automations.notScheduled')

export const formatNextRunTerse = (
    value: string | null,
    timeZone?: string
): string =>
    value
        ? formatUpcoming(new Date(value), true, timeZone)
        : t('web.automations.notScheduled')

export const formatExactDateTime = (
    value: string,
    timeZone?: string
): string =>
    new Date(value).toLocaleString(getLocale(), {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })

export const formatRelativePast = (value: string): string => {
    const elapsed = Date.now() - new Date(value).getTime()
    if (elapsed < 60000) return t('web.automations.justNow')
    const minutes = Math.floor(elapsed / 60000)
    if (minutes < 60) return t('web.automations.minutesAgo', { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return t('web.automations.hoursAgo', { count: hours })
    const days = Math.floor(hours / 24)
    if (days < 7) return t('web.automations.daysAgo', { count: days })
    return new Date(value).toLocaleDateString(getLocale(), {
        month: 'short',
        day: 'numeric'
    })
}

export const formatRunDuration = (
    startedAt: string,
    finishedAt: string | null
): string | null => {
    if (!finishedAt) return null
    const elapsed =
        new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    if (elapsed < 0) return null
    const seconds = Math.max(1, Math.round(elapsed / 1000))
    if (seconds < 60) return t('web.automations.durationSeconds', { seconds })
    return t('web.automations.durationMinutes', {
        minutes: Math.floor(seconds / 60),
        seconds: seconds % 60
    })
}

export const presetLabel = (preset: AutomationSchedulePreset): string => {
    if (preset === 'hourly') return t('web.automations.hourly')
    if (preset === 'daily') return t('web.automations.daily')
    if (preset === 'weekdays') return t('web.automations.weekdays')
    if (preset === 'weekly') return t('web.automations.weekly')
    return t('web.automations.custom')
}

export const parseTimeFromRrule = (rrule: string): string => {
    const hour = Number(rruleValue(rrule, 'BYHOUR') ?? 9)
    const minute = Number(rruleValue(rrule, 'BYMINUTE') ?? 0)
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export const parseWeekdayFromRrule = (rrule: string): string => {
    const byday = rruleValue(rrule, 'BYDAY') ?? 'MO'
    const first = byday.split(',')[0] ?? 'MO'
    return weekdayOptions.some((option) => option.code === first) ? first : 'MO'
}

const parseTime = (time: string): { hour: number; minute: number } => {
    const [hourRaw, minuteRaw] = time.split(':')
    const hour = clamp(Number(hourRaw), 0, 23)
    const minute = clamp(Number(minuteRaw), 0, 59)
    return { hour, minute }
}

const clamp = (value: number, min: number, max: number): number =>
    Number.isFinite(value) ? Math.min(Math.max(value, min), max) : min

const rruleValue = (rrule: string, key: string): string | null => {
    const match = rrule.match(new RegExp(`(?:^|;)${key}=([^;]+)`, 'i'))
    return match?.[1] ?? null
}

const formatLocalTime = (hour: number, minute: number): string =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(getLocale(), {
        hour: 'numeric',
        minute: '2-digit'
    })

export type RruleDescription =
    | { ok: true; text: string }
    | { ok: false; message: string }

const WEEKDAY_CODES = weekdayOptions.map((option) => option.code)
const WORKWEEK = ['MO', 'TU', 'WE', 'TH', 'FR']

const rruleParts = (value: string): Map<string, string> => {
    const parts = new Map<string, string>()
    for (const chunk of value.replace(/^\s*RRULE:/i, '').split(';')) {
        const [key, ...rest] = chunk.split('=')
        if (!key?.trim()) continue
        parts.set(key.trim().toUpperCase(), rest.join('=').trim())
    }
    return parts
}

const boundedInt = (
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number
): number | null => {
    if (raw === undefined || raw === '') return fallback
    // A list (BYHOUR=9,17) fires more often than a single number can describe,
    // so it reads as unreadable rather than being narrowed to its first entry
    // and reported back as a schedule the automation does not keep.
    if (raw.includes(',')) return null
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) return null
    return value
}

const weekdayNames = (codes: string[]): string =>
    new Intl.ListFormat(getLocale(), {
        style: 'long',
        type: 'conjunction'
    }).format(
        codes.map((code) =>
            t(
                weekdayOptions.find((option) => option.code === code)
                    ?.labelKey ?? 'web.automations.monday'
            )
        )
    )

// Reads the RRULE subset the schedule picker can produce and says it back in
// plain language, so a hand-typed custom rule fails at the keystroke instead
// of at save time.
export const describeRrule = (value: string): RruleDescription => {
    const parts = rruleParts(value)
    const freq = parts.get('FREQ')?.toUpperCase()
    if (!freq)
        return { ok: false, message: t('web.automations.rruleMissingFreq') }

    const interval = boundedInt(parts.get('INTERVAL'), 1, 1, 999)
    if (interval === null)
        return { ok: false, message: t('web.automations.rruleBadInterval') }
    const hour = boundedInt(parts.get('BYHOUR'), 9, 0, 23)
    if (hour === null)
        return { ok: false, message: t('web.automations.rruleBadHour') }
    const minute = boundedInt(parts.get('BYMINUTE'), 0, 0, 59)
    if (minute === null)
        return { ok: false, message: t('web.automations.rruleBadMinute') }
    const time = formatLocalTime(hour, minute)
    const paddedMinute = String(minute).padStart(2, '0')

    if (freq === 'HOURLY')
        return {
            ok: true,
            text:
                interval === 1
                    ? t('web.automations.previewHourly', {
                          minute: paddedMinute
                      })
                    : t('web.automations.previewEveryNHours', {
                          count: interval,
                          minute: paddedMinute
                      })
        }

    if (freq === 'DAILY')
        return {
            ok: true,
            text:
                interval === 1
                    ? t('web.automations.previewDaily', { time })
                    : t('web.automations.previewEveryNDays', {
                          count: interval,
                          time
                      })
        }

    if (freq === 'WEEKLY') {
        const raw = parts.get('BYDAY')
        const codes = raw
            ? raw
                  .split(',')
                  .map((code) => code.trim().toUpperCase())
                  .filter((code) => code !== '')
            : ['MO']
        const unknown = codes.find((code) => !WEEKDAY_CODES.includes(code))
        if (unknown)
            return {
                ok: false,
                message: t('web.automations.rruleUnknownWeekday', {
                    value: unknown
                })
            }
        const ordered = WEEKDAY_CODES.filter((code) => codes.includes(code))
        if (
            interval === 1 &&
            ordered.length === WORKWEEK.length &&
            WORKWEEK.every((code) => ordered.includes(code))
        )
            return {
                ok: true,
                text: t('web.automations.previewWeekdays', { time })
            }
        const days = weekdayNames(ordered)
        return {
            ok: true,
            text:
                interval === 1
                    ? t('web.automations.previewWeekly', { days, time })
                    : t('web.automations.previewEveryNWeeks', {
                          count: interval,
                          days,
                          time
                      })
        }
    }

    if (freq === 'MONTHLY') {
        const day = boundedInt(parts.get('BYMONTHDAY'), 1, 1, 31)
        if (day === null)
            return { ok: false, message: t('web.automations.rruleBadMonthDay') }
        return {
            ok: true,
            text: t('web.automations.previewMonthly', { day, time })
        }
    }

    return {
        ok: false,
        message: t('web.automations.rruleUnknownFreq', { value: freq })
    }
}

export interface AutomationTemplate {
    id: string
    preset: AutomationSchedulePreset
    time: string
    titleKey: string
    promptKey: string
}

export const automationTemplates: AutomationTemplate[] = [
    {
        id: 'briefing',
        preset: 'daily',
        time: '09:00',
        titleKey: 'web.automations.templateBriefingTitle',
        promptKey: 'web.automations.templateBriefingPrompt'
    },
    {
        id: 'report',
        preset: 'weekly',
        time: '18:00',
        titleKey: 'web.automations.templateReportTitle',
        promptKey: 'web.automations.templateReportPrompt'
    },
    {
        id: 'watch',
        preset: 'hourly',
        time: defaultTime,
        titleKey: 'web.automations.templateWatchTitle',
        promptKey: 'web.automations.templateWatchPrompt'
    }
]
