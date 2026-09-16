import { parseObjectId } from './object-id'
import { createBrowserSentryScrubber } from './browser-sentry-scrub'

interface BrowserLogger {
    info: (message: string, fields?: Record<string | symbol, unknown>) => void
    warn: (message: string, fields?: Record<string | symbol, unknown>) => void
    error: (message: string, fields?: Record<string | symbol, unknown>) => void
    flush: () => Promise<unknown>
}

interface BrowserError {
    message: string
    stack: string
    filename: string
    firstParty?: boolean
}

const WINDOW_MS = 60_000
const MAX_FINGERPRINTS = 100
const EXTENSION_URL = /(?:chrome|moz|safari(?:-web)?)-extension:\/\//i
const FOREIGN_MESSAGE =
    /^(?:Error:\s*)?Invalid call to runtime\.sendMessage\(\)\. Tab not found\.$/
const scrubUrl = createBrowserSentryScrubber().scrubUrl

const stringField = (value: unknown, key: string): string => {
    try {
        const field =
            value && typeof value === 'object'
                ? (value as Record<string, unknown>)[key]
                : undefined
        return typeof field === 'string' ? field.slice(0, 8_192) : ''
    } catch {
        return ''
    }
}

export const normalizeBrowserError = (reason: unknown): BrowserError => ({
    message:
        reason === null ||
        (typeof reason !== 'object' && typeof reason !== 'function')
            ? String(reason).slice(0, 8_192)
            : stringField(reason, 'message') || 'Unknown browser error',
    stack: stringField(reason, 'stack'),
    filename: stringField(reason, 'filename')
})

export const isForeignBrowserError = (
    error: BrowserError,
    origin: string
): boolean => {
    // An app stack is positive evidence: do not hide a real application failure
    // just because it mentions an extension or repeats its error message.
    if (
        error.firstParty ||
        (origin &&
            (error.filename.startsWith(origin + '/') ||
                error.stack.includes(origin + '/')))
    )
        return false
    return (
        FOREIGN_MESSAGE.test(error.message.trim()) ||
        EXTENSION_URL.test(error.filename) ||
        EXTENSION_URL.test(error.stack)
    )
}

const fingerprintFor = (error: BrowserError): string => {
    const text = `${error.message}\n${error.filename}\n${error.stack}`
        .replace(/\b[a-z]{2,8}_[a-z2-7]{26}\b/g, ':id')
        .replace(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/gi, ':id')
        .replace(/[?#][^\s)]+/g, '')
        .replace(/:\d+:\d+\b/g, ':line:column')
    let hash = 2_166_136_261
    for (let i = 0; i < text.length; i++)
        hash = Math.imul(hash ^ text.charCodeAt(i), 16_777_619)
    return (hash >>> 0).toString(16).padStart(8, '0')
}

interface Suppression {
    fingerprint: string
    reason: 'foreign-extension' | 'duplicate' | 'capacity'
    suppressedCount: number
}

export const createBrowserErrorLimiter = (options: {
    now?: () => number
    onSummary: (summary: Suppression[]) => void
}) => {
    const now = options.now ?? Date.now
    let started = now()
    let lastSummary = -Infinity
    const seen = new Set<string>()
    const suppressed = new Map<string, Suppression>()
    return {
        allow(error: BrowserError, foreign: boolean): string | null {
            if (now() - started >= WINDOW_MS) {
                started = now()
                seen.clear()
            }
            const fingerprint = foreign
                ? 'foreign-extension'
                : fingerprintFor(error)
            const reason = foreign
                ? 'foreign-extension'
                : seen.has(fingerprint)
                  ? 'duplicate'
                  : seen.size >= MAX_FINGERPRINTS
                    ? 'capacity'
                    : null
            if (!reason) {
                seen.add(fingerprint)
                return fingerprint
            }
            const key =
                reason === 'capacity' ||
                (!suppressed.has(fingerprint) &&
                    suppressed.size >= MAX_FINGERPRINTS)
                    ? 'overflow'
                    : fingerprint
            const entry = suppressed.get(key) ?? {
                fingerprint: key,
                reason,
                suppressedCount: 0
            }
            entry.suppressedCount++
            suppressed.set(key, entry)
            return null
        },
        flushSummary(): void {
            if (!suppressed.size || now() - lastSummary < WINDOW_MS) return
            const entries = [...suppressed.values()]
            suppressed.clear()
            lastSummary = now()
            options.onSummary(entries)
        }
    }
}

interface BrowserSentryEvent {
    message?: string
    exception?: {
        values?: Array<{
            value?: string
            stacktrace?: {
                frames?: Array<{ filename?: string; in_app?: boolean }>
            }
        }>
    }
}

export const createBrowserTelemetry = (
    logger: BrowserLogger,
    options: {
        origin: string
        now?: () => number
    }
) => {
    const limiter = (sink: 'axiom' | 'sentry') =>
        createBrowserErrorLimiter({
            now: options.now,
            onSummary: (fingerprints) =>
                logger.warn('browser.error.suppressed', {
                    sink,
                    windowMs: WINDOW_MS,
                    fingerprints,
                    suppressedCount: fingerprints.reduce(
                        (count, item) => count + item.suppressedCount,
                        0
                    )
                })
        })
    const axiom = limiter('axiom')
    const sentry = limiter('sentry')
    const flush = async (): Promise<void> => {
        // Neither a lifecycle callback nor the error handler can feed a failed
        // telemetry transport back into unhandledrejection.
        try {
            axiom.flushSummary()
            sentry.flushSummary()
            await logger.flush()
        } catch {
            // The transport owns retry; reporting its rejection recurses.
        }
    }
    return {
        flush,
        capture(
            name: 'window.error' | 'unhandledrejection',
            reason: unknown,
            location: {
                filename?: string
                lineno?: number
                colno?: number
            } = {}
        ): void {
            try {
                const error = { ...normalizeBrowserError(reason), ...location }
                const fingerprint = axiom.allow(
                    error,
                    isForeignBrowserError(error, options.origin)
                )
                if (fingerprint)
                    logger.error(name, {
                        ...error,
                        fingerprint,
                        [name === 'unhandledrejection' ? 'reason' : 'error']:
                            error.stack.includes(error.message)
                                ? error.stack
                                : [error.message, error.stack]
                                      .filter(Boolean)
                                      .join('\n')
                    })
            } catch {
                // Arbitrary rejection objects and logger failures must not recurse.
            }
        },
        beforeSend<T extends BrowserSentryEvent>(
            event: T,
            hint: { originalException?: unknown } = {}
        ): T | null {
            const error = normalizeBrowserError(
                hint.originalException ??
                    event.message ?? { message: 'Unknown browser error' }
            )
            const values = event.exception?.values ?? []
            const frames = values.flatMap(
                (value) => value.stacktrace?.frames ?? []
            )
            if (error.message === 'Unknown browser error')
                error.message = values.at(-1)?.value ?? error.message
            error.stack += frames
                .map((frame) => frame.filename ?? '')
                .join('\n')
            error.firstParty = frames.some(
                (frame) =>
                    frame.in_app === true &&
                    !EXTENSION_URL.test(frame.filename ?? '')
            )
            return sentry.allow(
                error,
                isForeignBrowserError(error, options.origin)
            )
                ? event
                : null
        },
        install(win: Window, doc: Document): () => void {
            const error = (event: ErrorEvent): void =>
                this.capture('window.error', event.error ?? event.message, {
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno
                })
            const rejection = (event: PromiseRejectionEvent): void =>
                this.capture('unhandledrejection', event.reason)
            const pagehide = (): void => {
                void flush()
            }
            const visibility = (): void => {
                if (doc.visibilityState === 'hidden') void flush()
            }
            win.addEventListener('error', error)
            win.addEventListener('unhandledrejection', rejection)
            win.addEventListener('pagehide', pagehide)
            doc.addEventListener('visibilitychange', visibility)
            const timer = win.setInterval(() => {
                void flush()
            }, WINDOW_MS)
            return () => {
                win.removeEventListener('error', error)
                win.removeEventListener('unhandledrejection', rejection)
                win.removeEventListener('pagehide', pagehide)
                doc.removeEventListener('visibilitychange', visibility)
                win.clearInterval(timer)
            }
        }
    }
}

interface WebVitalMetric {
    name: string
    value: number
    rating: string
    delta: number
    id: string
    navigationType: string
}

export const reportBrowserWebVital = (
    logger: Pick<BrowserLogger, 'info'>,
    metric: WebVitalMetric,
    pathname: string
): void => {
    const path = new URL(scrubUrl(pathname), 'http://manyfold.local').pathname
        .split('/')
        .map((segment) => (parseObjectId(segment) ? ':id' : segment))
        .join('/')
    const { name, value, rating, delta, id, navigationType } = metric
    logger.info('web-vital', {
        [Symbol.for('logging.event')]: {
            source: 'web-vital',
            path,
            webVital: { name, value, rating, delta, id, navigationType }
        }
    })
}
