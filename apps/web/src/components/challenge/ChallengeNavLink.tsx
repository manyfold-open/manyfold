import type { FC, ReactNode } from 'react'

// Editions slot (§3.3): the challenge nav entries belong to the cloud
// campaign; the cloud overlay shadows this with the promotable-aware links.
const ChallengeNavLink: FC = (): ReactNode => null

export const ChallengeNavMenuItem: FC<{ close: () => void }> = () => null

export default ChallengeNavLink
