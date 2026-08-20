// import.meta.env is injected by Vite at build time; the node test runner
// (this module is pulled in transitively by chatAgents.test.ts) has no such
// object, so guard the access instead of dereferencing undefined.
const docsBaseUrl = (
    import.meta.env?.VITE_DOCS_URL ?? 'https://docs.manyfold.ai'
).replace(/\/$/, '')

export const docsHref = (path: string): string => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    return `${docsBaseUrl}${normalizedPath}`
}
