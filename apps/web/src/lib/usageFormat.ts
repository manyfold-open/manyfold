import type { UsagePeriodSummary } from '@manyfold/shared'
import { getLocale } from '@manyfold/i18n'
import type { TFn } from '@/lib/i18n'

export const fmt = (n: number): string =>
    new Intl.NumberFormat(getLocale()).format(n)

export const fmtTokens = (n: number): string =>
    new Intl.NumberFormat(getLocale(), {
        notation: 'compact',
        maximumSignificantDigits: 3
    }).format(n)

// NetMind finance strings can carry 4 decimals ("9.9300"); show 2 with a $
// prefix. null / '' / non-numeric → em dash. Ported from NarraNexus money().
/** @public consumed by the web-cloud overlay tree */
export const fmtNetmindMoney = (v: string | number | null): string => {
    if (v === null || v === '') return '—'
    const n = Number(v)
    return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—'
}

export const fmtCost = (n: number | null): string =>
    n === null
        ? '—'
        : new Intl.NumberFormat(getLocale(), {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 4
          }).format(n)

export const formatDuration = (ms: number): string => {
    if (!Number.isFinite(ms) || ms < 0) return '—'
    if (ms < 1000) return `${Math.round(ms)}ms`
    const units: { value: number; suffix: string }[] = [
        { value: 3600000, suffix: 'h' },
        { value: 60000, suffix: 'm' },
        { value: 1000, suffix: 's' }
    ]
    for (const unit of units) {
        if (ms < unit.value) continue
        const scaled = ms / unit.value
        const text = scaled.toFixed(scaled >= 10 ? 0 : 1)
        const trimmed = text.includes('.') ? text.replace(/\.?0+$/, '') : text
        return `${trimmed}${unit.suffix}`
    }
    return `${Math.round(ms)}ms`
}

export const daysAgoIso = (days: number): string => {
    const d = new Date()
    d.setUTCHours(0, 0, 0, 0)
    d.setUTCDate(d.getUTCDate() - days)
    return d.toISOString()
}

export const hoursAgoIso = (hours: number): string =>
    new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

// Period boundaries are UTC instants; render them AS UTC dates or users west
// of UTC see every boundary off by one day. The window is [start, end), so the
// displayed range shows the inclusive last day while "resets" names the
// exclusive boundary itself.
export const utcDateLabel = (iso: string): string =>
    new Date(iso).toLocaleDateString(getLocale(), {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    })

export const usagePeriodLine = (period: UsagePeriodSummary, t: TFn): string => {
    const end = new Date(period.end)
    const inclusiveEnd = new Date(end.getTime() - 24 * 60 * 60 * 1000)
    return t('web.planAndBilling.usagePeriodRange', {
        start: utcDateLabel(period.start),
        end: utcDateLabel(inclusiveEnd.toISOString()),
        resetDate: utcDateLabel(period.end)
    })
}

export const formatLocalDateTime = (iso: string): string =>
    new Date(iso).toLocaleString(getLocale(), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })

export const formatTableDateTime = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(getLocale(), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })
}

export const formatShortDate = (iso: string): string => {
    const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' })
}

export const formatHourLabel = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleTimeString(getLocale(), {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    })
}
