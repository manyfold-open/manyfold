import type { ReactElement } from 'react'

// Editions slot (§3.4): route entries a composition layer adds inside the
// authenticated admin shell. Empty in the open-source build; the cloud
// overlay shadows this module with the commercial admin routes (challenge,
// growth, payments, subscriptions, container SKUs, waitlist) as those pages
// migrate into apps/admin-cloud.
export interface ExtraAdminRoute {
    path: string
    element: ReactElement
}

export const extraAdminRoutes: ExtraAdminRoute[] = []

// Legacy-URL redirects the composition layer adds alongside its routes:
// straight path renames, parameterized renames, and extra `?view=` targets
// merged into the core query-redirect definitions by `from` path.
export const extraLegacyPathRedirects: Array<{
    from: string
    to: string
}> = []

export const extraLegacyParamRedirects: Array<{
    from: string
    name: string
    to: (value: string) => string
}> = []

export const extraLegacyQueryTargets: Record<
    string,
    Record<string, string>
> = {}
