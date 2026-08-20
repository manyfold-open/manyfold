import { parseObjectId } from '@manyfold/shared'
import { scrubSentryUrl } from '@/lib/sentryScrub'

// Internal ObjectIds (agent, session, …) never go to Google: any path
// segment in the id format collapses to the route shape. Sentry keeps the
// real path — the ids are ours and first-party debugging wants them.
const normalizeGaPath = (pathname: string): string =>
    pathname
        .split('/')
        .map((segment) => (parseObjectId(segment) ? ':id' : segment))
        .join('/')

// GA4 wants an absolute URL, and it must not carry the login hand-off
// fragment (`#session=` / `#nmtoken=`) — hence a signature that has nowhere
// to put a hash, plus the same query/path redaction Sentry already uses.
export const gaPageLocation = (
    origin: string,
    pathname: string,
    search: string
): string => `${origin}${scrubSentryUrl(`${normalizeGaPath(pathname)}${search}`)}`