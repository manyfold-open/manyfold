import type { FC, ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { AuthUserButton, SignedIn, SignedOut } from '@/lib/auth'
import { loginUrl, nextPath } from '@/lib/loginRedirect'
import { Card, Heading } from '@/ui'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface Props {
    children: ReactNode
}

const ProtectedRoute: FC<Props> = ({ children }): ReactNode => {
    // This guard fronts every admin deep link, so the attempted URL rides along
    // to the login page and back.
    const location = useLocation()
    return (
        <>
            <SignedIn>
                <AdminGate>{children}</AdminGate>
            </SignedIn>
            <SignedOut>
                <Navigate to={loginUrl(nextPath(location))} replace />
            </SignedOut>
        </>
    )
}

const AdminGate: FC<Props> = ({ children }): ReactNode => {
    const { user, isAdmin, loading, error } = useCurrentUser()

    if (loading) {
        return (
            <div className='flex min-h-screen items-center justify-center bg-white p-4'>
                <p className='text-caption text-body'>Loading...</p>
            </div>
        )
    }

    if (error || !user || !isAdmin) {
        return (
            <div className='bg-surface-muted flex min-h-screen items-center justify-center p-4'>
                <Card elevation='ambient' className='w-full max-w-md p-4'>
                    <div className='mb-5 flex items-center justify-between gap-4'>
                        <Heading level={3}>Admin access required</Heading>
                        <AuthUserButton />
                    </div>
                    <p className='admin-page-description'>
                        {error ??
                            'Your account is signed in, but it does not have the admin role.'}
                    </p>
                </Card>
            </div>
        )
    }

    return children
}

export default ProtectedRoute