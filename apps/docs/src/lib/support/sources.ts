import type { RetrieverResource } from './difyClient'

const MAX_SOURCES = 4

export type ResolvedSource = {
    title: string
    href: string | null
}

type SourceMap = Record<string, { href: string; title: string }>

let cache: SourceMap | null = null
let inflight: Promise<SourceMap> | null = null

const loadMap = async (): Promise<SourceMap> => {
    if (cache) return cache
    if (!inflight)
        inflight = fetch('/support-sources.json')
            .then((res) => (res.ok ? (res.json() as Promise<SourceMap>) : {}))
            .catch(() => ({}) as SourceMap)
            .then((map) => {
                cache = map
                return map
            })
    return inflight
}

const prettify = (documentName: string): string =>
    documentName
        .replace(/\.md$/, '')
        .split('--')
        .slice(1)
        .join(' / ')
        .replace(/-/g, ' ') || documentName

const score = (resource: RetrieverResource): number => Number(resource.score) || 0

// 'en--channels--lark.md' and 'zh--channels--lark.md' are the same page in two
// languages; retrieval routinely returns both. Collapse them onto the slug so a
// reader sees one link per page, in their own language when it exists.
const slugOf = (documentName: string): string =>
    documentName.split('--').slice(1).join('--')

const localeOf = (documentName: string): string =>
    documentName.split('--')[0] ?? ''

export const resolveSources = async (
    resources: RetrieverResource[],
    locale: string
): Promise<ResolvedSource[]> => {
    if (!resources.length) return []
    const best = new Map<string, RetrieverResource>()
    resources.forEach((resource) => {
        const name = resource.document_name
        if (!name) return
        const key = slugOf(name) || name
        const existing = best.get(key)
        if (!existing) {
            best.set(key, resource)
            return
        }
        const existingName = existing.document_name ?? ''
        const preferred = localeOf(name) === locale
        const existingPreferred = localeOf(existingName) === locale
        if (preferred && !existingPreferred) best.set(key, resource)
        else if (preferred === existingPreferred && score(resource) > score(existing))
            best.set(key, resource)
    })
    if (!best.size) return []
    const map = await loadMap()
    return Array.from(best.values())
        .sort((a, b) => score(b) - score(a))
        .slice(0, MAX_SOURCES)
        .map((resource) => {
            const name = resource.document_name as string
            const hit = map[name]
            if (hit) return { title: hit.title, href: hit.href }
            // Dify's dataset is uploaded separately and can lag the shipped docs.
            // A miss renders as an inert chip rather than a dead link.
            if (import.meta.env.DEV)
                console.warn('[support] citation not in published docs:', name)
            return { title: prettify(name), href: null }
        })
}