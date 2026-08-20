import { getLocale } from '@manyfold/i18n'

export const timeAgo = (iso: string, now: Date = new Date()): string => {
    const diffMs = now.getTime() - new Date(iso).getTime()
    const s = Math.max(0, Math.floor(diffMs / 1000))
    const formatter = new Intl.RelativeTimeFormat(getLocale(), {
        numeric: 'auto',
        style: 'narrow'
    })

    if (s < 45) return formatter.format(0, 'second')
    const m = Math.floor(s / 60)
    if (m < 60) return formatter.format(-m, 'minute')
    const h = Math.floor(m / 60)
    if (h < 24) return formatter.format(-h, 'hour')
    const d = Math.floor(h / 24)
    if (d < 30) return formatter.format(-d, 'day')
    const mo = Math.floor(d / 30)
    if (mo < 12) return formatter.format(-mo, 'month')
    return formatter.format(-Math.floor(mo / 12), 'year')
}
