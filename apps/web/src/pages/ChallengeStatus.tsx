import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): cloud overlay shadows this with the participant
// status page.
const ChallengeStatus: FC = () => <Navigate to='/' replace />

export default ChallengeStatus
