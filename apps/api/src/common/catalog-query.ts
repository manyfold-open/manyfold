import type { CatalogSort } from '@manyfold/shared'
import { BadRequestException } from '@nestjs/common'

const escapeLike = (value: string): string =>
    value.replace(/[\\%_]/g, (m) => `\\${m}`)

export const likeNeedle = (q: string): string => `%${escapeLike(q.trim())}%`

export const parseOffsetCursor = (cursor?: string): number => {
    if (!cursor) return 0
    const parsed = Number.parseInt(cursor, 10)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export const clampPageLimit = (
    limit: number | undefined,
    def: number,
    max: number
): number => Math.min(Math.max(1, limit ?? def), max)

export const parseCatalogSort = (sort?: string): CatalogSort | undefined => {
    if (sort === undefined) return undefined
    if (sort !== 'featured' && sort !== 'latest')
        throw new BadRequestException('sort must be featured or latest')
    return sort
}

export const parseCatalogLimit = (limit?: string): number | undefined => {
    if (limit === undefined) return undefined
    const parsed = Number.parseInt(limit, 10)
    if (!Number.isFinite(parsed) || parsed < 1)
        throw new BadRequestException('limit must be a positive integer')
    return parsed
}

export const normalizeCatalogTags = (
    tags: string[] | undefined
): string[] => {
    if (!tags) return []
    const seen = new Set<string>()
    for (const tag of tags) {
        const trimmed = tag.trim()
        if (trimmed) seen.add(trimmed)
    }
    return [...seen]
}
