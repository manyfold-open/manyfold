import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): billing is a cloud surface (the open-source API has
// no billing routes); the cloud overlay shadows this with the real page.
const PlanAndBilling: FC = () => <Navigate to='/settings' replace />

export default PlanAndBilling
