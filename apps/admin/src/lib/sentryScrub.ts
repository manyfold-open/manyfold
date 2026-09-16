import { createBrowserSentryScrubber } from '@manyfold/shared'
import type { Breadcrumb, Event } from '@sentry/react'
import { SENTRY_REMOVED_QUERY_PARAMS } from '@/lib/sentryPrivacy'

const policy = createBrowserSentryScrubber({
    removedQueryParams: SENTRY_REMOVED_QUERY_PARAMS
})

export const scrubSentryBreadcrumb: <T extends Breadcrumb>(crumb: T) => T =
    policy.scrubBreadcrumb
export const scrubSentrySpan: <T extends NonNullable<Event['spans']>[number]>(
    span: T
) => T = policy.scrubSpan
export const scrubSentryEvent: <T extends Event>(event: T) => T =
    policy.scrubEvent
