import type { FC, ReactNode } from 'react'

// Editions slot (§3.3): the entrances to the cloud marketing page outside the
// nav's menus — the footer's Product column and the way out of the landing
// tour's hosting scene. (Its place in the Product menu comes through
// editionNavMenus.) The page argues the hosted offering, which an open-source
// install does not have — and `pages/CloudLanding.tsx` redirects home here —
// so a hard-coded link would bounce a self-hosting visitor off a page that
// does not exist for them. The cloud overlay shadows this file with the real
// links.
export const CloudFooterLink: FC = (): ReactNode => null

export const CloudSectionLink: FC = (): ReactNode => null
