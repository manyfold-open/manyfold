import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): plans have no prices on a self-hosted deployment
// (the seeded unlimited tier is free); the cloud overlay shadows this with
// the real pricing page.
const Pricing: FC = () => <Navigate to='/settings' replace />

export default Pricing
