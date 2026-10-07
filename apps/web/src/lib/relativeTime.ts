import { t as translate } from '@manyfold/i18n'

export const relative = (value: string | null): string => {
    if (!value) return '—'
    // A stamp a moment ahead of this clock is skew between the runtime, the
    // API and the browser, not an unknown time: it reads as "0s ago".
    const sec = Math.max(
        0,
        Math.round((Date.now() - new Date(value).getTime()) / 1000)
    )
    if (sec < 60)
        return translate('web.runtimeDetails.secondsAgo', { count: sec })
    const min = Math.round(sec / 60)
    if (min < 60)
        return translate('web.runtimeDetails.minutesAgo', { count: min })
    const hr = Math.round(min / 60)
    if (hr < 24)
        return translate('web.runtimeDetails.hoursAgo', { count: hr })
    const d = Math.round(hr / 24)
    return translate('web.runtimeDetails.daysAgo', { count: d })
}
