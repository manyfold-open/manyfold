import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): the page selling work a composition's own team builds
// for other businesses, which an open-source install has no team behind; the
// cloud overlay shadows this with the real page.
const SolutionsLanding: FC = () => <Navigate to='/' replace />

export default SolutionsLanding
