import type { FC, ReactNode } from 'react'

// Editions slot (§3.3): every entrance to the cloud acquisition page — the
// nav bar, the folded menu, the footer's Product column, and the way out of
// the landing tour's hosting scene. The page argues the hosted offering,
// which an open-source install does not have — and `pages/CloudLanding.tsx`
// redirects home here — so a hard-coded link would bounce a self-hosting
// visitor off a page that does not exist for them. The cloud overlay shadows
// this file with the real links.
const CloudNavLink: FC = (): ReactNode => null

export const CloudNavMenuItem: FC<{ close: () => void }> = () => null

export const CloudFooterLink: FC = (): ReactNode => null

export const CloudSectionLink: FC = (): ReactNode => null

export default CloudNavLink
