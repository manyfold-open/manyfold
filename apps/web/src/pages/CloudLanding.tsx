import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): the cloud marketing page argues the hosted plans,
// which open source does not have; the cloud overlay shadows this with the
// real page.
const CloudLanding: FC = () => <Navigate to='/' replace />

export default CloudLanding
