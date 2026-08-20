import type { FC, ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { AuthUserButton, SignedIn, SignedOut } from '@/lib/auth'
import { adminRoutes } from '@/routes'
import { Card, Heading } from '@/ui'
import { useCurrentUser } from '@/lib/useCurrentUser'

interface Props {
    children: ReactNode
}

const ProtectedRoute: FC<Props> = ({ children }): ReactNode => {
    return (
        <>
            <SignedIn>
                <AdminGate>{children}</AdminGate>
            </SignedIn>
            <SignedOut>
                <Navigate to={adminRoutes.login} replace />
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