import type { FC } from 'react'
import { Navigate } from 'react-router-dom'

// Editions slot (§3.3): waitlist invites are a cloud flow; open-source
// signup is direct, so an invite link just lands on the app. The cloud
// overlay shadows this with the redemption page.
const Invite: FC = () => <Navigate to='/' replace />

export default Invite
