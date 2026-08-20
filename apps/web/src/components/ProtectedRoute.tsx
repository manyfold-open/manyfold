import type { FC, ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { SignedIn, SignedOut, useAppAuth } from '@/lib/auth'
import BootScreen from '@/components/BootScreen'

interface Props {
    children: ReactNode
}

const ProtectedRoute: FC<Props> = ({ children }): ReactNode => {
    const { isLoaded } = useAppAuth()
    // Until the session resolves neither SignedIn nor SignedOut renders,
    // so without this the boot ends in a blank frame between the chunk
    // landing and the session answering.
    if (!isLoaded) return <BootScreen />
    return (
        <>
            <SignedIn>{children}</SignedIn>
            <SignedOut>
                <Navigate to='/login' replace />
            </SignedOut>
        </>
    )
}

export default ProtectedRoute
