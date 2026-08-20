import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): the challenge campaign is a cloud event; the cloud
// overlay shadows this with the real page.
const Challenge: FC = () => <Navigate to='/' replace />

export default Challenge
