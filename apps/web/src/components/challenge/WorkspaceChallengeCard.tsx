import type { FC } from 'react'

// Editions slot (§3.3): the workspace challenge card advertises the cloud
// campaign; the cloud overlay shadows this with the real card.
type Props = {
    variant?: 'sidebar' | 'strip'
    collapsed?: boolean
}

const WorkspaceChallengeCard: FC<Props> = () => null

export default WorkspaceChallengeCard
