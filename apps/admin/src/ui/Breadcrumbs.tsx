import type { FC, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from './classNames'

export interface BreadcrumbItem {
    label: ReactNode
    to?: string
}

interface BreadcrumbsProps {
    items: BreadcrumbItem[]
    className?: string
}

export const Breadcrumbs: FC<BreadcrumbsProps> = ({
    items,
    className
}): ReactNode => (
    <nav aria-label='Breadcrumb' className={cn('mb-2', className)}>
        <ol className='text-caption-sm text-body flex min-w-0 flex-wrap items-center gap-1'>
            {items.map((item, index) => {
                const isLast = index === items.length - 1
                return (
                    <li key={index} className='flex min-w-0 items-center gap-1'>
                        {index > 0 && (
                            <ChevronRight
                                aria-hidden='true'
                                size={14}
                                strokeWidth={1.75}
                                className='text-label shrink-0'
                            />
                        )}
                        {item.to && !isLast ? (
                            <Link
                                to={item.to}
                                className='hover:text-heading focus-visible:ring-brand -mx-1 block max-w-[24rem] min-w-0 truncate rounded px-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
                            >
                                {item.label}
                            </Link>
                        ) : (
                            <span
                                aria-current={isLast ? 'page' : undefined}
                                className='text-heading block max-w-[32rem] min-w-0 truncate'
                            >
                                {item.label}
                            </span>
                        )}
                    </li>
                )
            })}
        </ol>
    </nav>
)
