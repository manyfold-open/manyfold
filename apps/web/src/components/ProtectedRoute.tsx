import type { FC, ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { SignedIn, SignedOut, useAppAuth } from '@/lib/auth'
import BootScreen from '@/components/BootScreen'
import { loginUrl, nextPath } from '@/lib/loginRedirect'

interface Props {
    children: ReactNode
}

const ProtectedRoute: FC<Props> = ({ children }): ReactNode => {
    const { isLoaded } = useAppAuth()
    // This guard fronts every deep link into the app, so the attempted URL has
    // to ride along: without it a shared /agents/new?framework=… link is a dead
    // link for anyone not already signed in.
    const location = useLocation()
    // Until the session resolves neither SignedIn nor SignedOut renders,
    // so without this the boot ends in a blank frame between the chunk
    // landing and the session answering.
    if (!isLoaded) return <BootScreen />
    return (
        <>
            <SignedIn>{children}</SignedIn>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
            </SignedOut>
        </>
    )
}

export default ProtectedRoute
