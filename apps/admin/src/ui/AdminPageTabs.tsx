import type { FC, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cn } from './classNames'

export interface AdminPageTab {
    id: string
    label: string
    to: string
}

interface AdminPageTabsProps {
    activeId: string
    ariaLabel: string
    tabs: AdminPageTab[]
}

export const AdminPageTabs: FC<AdminPageTabsProps> = ({
    activeId,
    ariaLabel,
    tabs
}): ReactNode => (
    <nav
        aria-label={ariaLabel}
        className='border-border mb-3 flex gap-1 overflow-x-auto border-b'
    >
        {tabs.map((tab) => {
            const active = tab.id === activeId
            return (
                <Link
                    key={tab.id}
                    to={tab.to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                        'text-caption focus-visible:ring-brand -mb-px inline-flex h-9 shrink-0 items-center border-b-2 px-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                        active
                            ? 'border-brand text-brand'
                            : 'text-body hover:border-border hover:text-heading border-transparent'
                    )}
                >
                    {tab.label}
                </Link>
            )
        })}
    </nav>
)
