import type { FC, ReactNode } from 'react'
import UsersList from '@/pages/Users/UsersList'
import { TabbedPage } from '@/pages/consolidated/TabbedPage'
import { adminRoutes } from '@/routes'

// Editions slot (§3.4): the open-source accounts surface is the users list;
// the cloud overlay shadows this with the full tab pair.
export const AccountsPage: FC<{
    view: string
}> = (): ReactNode => {
    return (
        <TabbedPage
            activeId='users'
            ariaLabel='Account management views'
            tabs={[
                {
                    id: 'users',
                    label: 'Users',
                    to: adminRoutes.accountUsers
                }
            ]}
        >
            <UsersList />
        </TabbedPage>
    )
}
