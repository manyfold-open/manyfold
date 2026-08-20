import type { UserRole } from '@manyfold/shared'
import { getLocale } from '@manyfold/i18n'
import type { BadgeTone } from '@/ui'

export const roleTone: Record<UserRole, BadgeTone> = {
    admin: 'brand',
    user: 'neutral'
}

export const formatCost = (value: number | null | undefined): string =>
    value === null || value === undefined
        ? '-'
        : new Intl.NumberFormat(getLocale(), {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 2
          }).format(value)

export const formatNumber = (value: number): string =>
    new Intl.NumberFormat(getLocale()).format(value)

export const formatDateTime = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString(getLocale()) : '-'
