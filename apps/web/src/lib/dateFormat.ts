import { getLocale } from '@manyfold/i18n'

type DateInput = string | number | Date | null | undefined

export const EMPTY_DATE_PLACEHOLDER = '—'

const toDate = (value: DateInput): Date | null => {
    if (value === null || value === undefined) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

export const formatDateTime = (
    value: DateInput,
    placeholder: string = EMPTY_DATE_PLACEHOLDER
): string => {
    const date = toDate(value)
    if (!date) return placeholder
    return date.toLocaleString(getLocale())
}

export const formatDate = (
    value: DateInput,
    placeholder: string = EMPTY_DATE_PLACEHOLDER
): string => {
    const date = toDate(value)
    if (!date) return placeholder
    return date.toLocaleDateString(getLocale())
}

export const formatTime = (
    value: DateInput,
    options?: Intl.DateTimeFormatOptions
): string | null => {
    const date = toDate(value)
    if (!date) return null
    return date.toLocaleTimeString(getLocale(), options)
}

export const formatMessageTimestamp = (value: DateInput): string | null => {
    const date = toDate(value)
    if (!date) return null
    return date.toLocaleString(getLocale(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    })
}
