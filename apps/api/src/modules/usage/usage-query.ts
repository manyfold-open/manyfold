import type { AgentFramework, UsageBucket, UsageQuery } from '@manyfold/shared'
import {
    isExternal,
    isRegisteredFramework,
    parseUsageInstant
} from '@manyfold/shared'
import { BadRequestException } from '@nestjs/common'

// Usage accrues to frameworks that run in a runtime; the external-API ones
// report none.
export const parseFramework = (value?: string): AgentFramework | undefined => {
    if (!value) return undefined
    if (isRegisteredFramework(value) && !isExternal(value)) return value
    throw new BadRequestException(`unknown framework: ${value}`)
}

export const parseBucket = (value?: string): UsageBucket => {
    if (value === 'hour' || value === 'day') return value
    if (!value) return 'day'
    throw new BadRequestException(`bucket must be 'hour' or 'day'`)
}

// Digits only: Number() takes ' 5', '0x10' and '1e2', and its NaN reached the
// query as no LIMIT at all. A repeated key arrives as an array. Above the
// endpoint's maximum the limit is capped, as before.
export const parseLimit = (
    value: unknown,
    fallback: number,
    max: number
): number => {
    if (value === undefined || value === '') return fallback
    if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1)
        throw new BadRequestException(
            'limit must be a whole number of at least 1'
        )
    return Math.min(max, Number(value))
}

// Before, a bound that did not parse was dropped, and the query ran over all
// time.
export const parseInstant = (
    name: 'from' | 'to',
    value: unknown
): string | undefined => {
    if (value === undefined || value === '') return undefined
    const at = typeof value === 'string' ? parseUsageInstant(value) : null
    if (!at)
        throw new BadRequestException(
            `${name} must be a date or timestamp such as 2026-10-01 or 2026-10-01T09:00:00Z`
        )
    return at.toISOString()
}

// The cursor is the createdAt of the last event on the previous page
// (UsageRepository.listEvents); one that did not parse restarted at the top.
export const parseCursor = (value: unknown): string | null => {
    if (value === undefined || value === '') return null
    if (typeof value !== 'string' || !parseUsageInstant(value))
        throw new BadRequestException(
            'invalid cursor; pass back the nextCursor of the previous page'
        )
    return value
}

export interface UsageQueryDto {
    from?: string
    to?: string
    framework?: string
    runtimeId?: string
    agentId?: string
    sessionId?: string
}

export const buildUserQuery = (
    userId: string,
    q: UsageQueryDto
): UsageQuery => ({
    userId,
    from: parseInstant('from', q.from),
    to: parseInstant('to', q.to),
    framework: parseFramework(q.framework),
    runtimeId: q.runtimeId,
    agentId: q.agentId,
    sessionId: q.sessionId
})
