import { createBrowserSentryScrubber } from '@manyfold/shared'
import type { Breadcrumb, Event } from '@sentry/react'
import { ATTRIBUTION_SCRUB_PARAMS } from '@/lib/attribution'
import { extraAuthHandoffs } from '@/lib/auth-handoffs-extra'

const policy = createBrowserSentryScrubber({
    removedQueryParams: ATTRIBUTION_SCRUB_PARAMS,
    redactedFragmentParams: extraAuthHandoffs.map(
        (handoff) => handoff.fragmentParam
    )
})

export const scrubSentryUrl = policy.scrubUrl
export const scrubSentryBreadcrumb: <T extends Breadcrumb>(crumb: T) => T =
    policy.scrubBreadcrumb
export const scrubSentrySpan: <T extends NonNullable<Event['spans']>[number]>(
    span: T
) => T = policy.scrubSpan
export const scrubSentryEvent: <T extends Event>(event: T) => T =
    policy.scrubEvent
