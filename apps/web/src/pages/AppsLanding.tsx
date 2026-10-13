import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): the page listing the apps a composition runs on its
// own agents, which an open-source install does not have; the cloud overlay
// shadows this with the real page.
const AppsLanding: FC = () => <Navigate to='/' replace />

export default AppsLanding
