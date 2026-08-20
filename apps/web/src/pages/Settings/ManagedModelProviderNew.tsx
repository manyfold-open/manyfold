import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): a cloud commerce surface; the cloud overlay shadows
// this with the real page.
const ManagedModelProviderNew: FC = () => <Navigate to='/settings' replace />

export default ManagedModelProviderNew
