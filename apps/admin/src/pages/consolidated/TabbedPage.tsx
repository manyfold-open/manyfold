import type { FC, ReactNode } from 'react'
import { AdminPageTabs, type AdminPageTab } from '@/ui'

export const TabbedPage: FC<{
    activeId: string
    ariaLabel: string
    children: ReactNode
    tabs: AdminPageTab[]
}> = ({ activeId, ariaLabel, children, tabs }): ReactNode => (
    <>
        <AdminPageTabs activeId={activeId} ariaLabel={ariaLabel} tabs={tabs} />
        {children}
    </>
)
