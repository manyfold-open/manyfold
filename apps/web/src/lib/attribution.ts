// Editions slot (§3.3): landing-touch attribution capture is a cloud
// acquisition feature. This open-source module captures nothing and adds
// nothing to signup calls; the cloud overlay shadows it with the real
// capture (which must stay the first import in main.tsx).

export interface AttributionTokens {
    firstTouchToken?: string
    lastTouchToken?: string
}

export const attributionTokens = (): AttributionTokens => ({})

// Query params the Sentry scrubber strips from URLs; none in open source.
export const ATTRIBUTION_SCRUB_PARAMS: readonly string[] = []

// For top-level navigations we don't control the body of (OAuth start).
export const withAttributionParams = (url: string): string => url
