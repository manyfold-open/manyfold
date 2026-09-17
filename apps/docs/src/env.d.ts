/// <reference types="astro/client" />

// The generated social cards need the vendored display face as bytes at build
// time, not as a URL a browser would fetch. `?inline` is what makes Vite hand
// back a data: URI for an asset over the inline size limit; nothing ships an
// ambient type for it.
declare module '*.ttf?inline' {
    const dataUri: string
    export default dataUri
}
