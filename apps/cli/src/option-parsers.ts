import { InvalidArgumentError } from 'commander'
import { parseUsageInstant } from '@manyfold/shared'

// Digits only: Number() takes ' 5', '0x10' and '1e2', and a NaN went out as
// the page size.
export const limitOption =
    (max: number) =>
    (value: string): number => {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
            throw new InvalidArgumentError(
                `limit must be a whole number from 1 to ${max}`
            )
        return Number(value)
    }

export const instantOption = (value: string): string => {
    if (!parseUsageInstant(value))
        throw new InvalidArgumentError(
            'expected a date or timestamp such as 2026-10-01 or 2026-10-01T09:00:00Z; a time without a zone is UTC'
        )
    return value
}
