// Paths whose handlers verify a signature over the exact bytes received, so
// the raw body must be buffered before any parser touches the stream
// (server-bootstrap installs the preParsing hook that consumes this list).
// Core ships the channel webhooks; an edition's composition root registers
// its own additions at module-load time. A leaf module on purpose: both the
// bootstrap and composition roots import it, so it must pull in nothing.
const rawBodyPathPrefixes = ['/api/channels/hooks/']

export const registerRawBodyPathPrefix = (prefix: string): void => {
    if (!rawBodyPathPrefixes.includes(prefix)) rawBodyPathPrefixes.push(prefix)
}

export const isRawBodyPath = (url: string): boolean =>
    rawBodyPathPrefixes.some((prefix) => url.startsWith(prefix))
