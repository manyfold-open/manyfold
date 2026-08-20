import type { FC, ReactNode } from 'react'
import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRightIcon } from '@/components/icons'
import { useI18n } from '@/lib/i18n'

export interface BreadcrumbItem {
    label: string
    to?: string
}

interface BreadcrumbProps {
    items: BreadcrumbItem[]
}

const Breadcrumb: FC<BreadcrumbProps> = ({ items }): ReactNode => {
    const { direction, t } = useI18n()
    return (
        <nav aria-label={t('common.breadcrumb')} className='settings-breadcrumb'>
            {items.map((item, index) => {
                const isLast = index === items.length - 1
                return (
                    <Fragment key={`${item.label}-${index}`}>
                        {index > 0 && (
                            <ChevronRightIcon
                                aria-hidden='true'
                                className={[
                                    'settings-crumb-sep',
                                    direction === 'rtl' ? 'rotate-180' : ''
                                ].join(' ')}
                            />
                        )}
                        {item.to && !isLast ? (
                            <Link
                                to={item.to}
                                className='settings-crumb-link'
                            >
                                {item.label}
                            </Link>
                        ) : (
                            <span
                                className='settings-crumb-current'
                                aria-current={isLast ? 'page' : undefined}
                            >
                                {item.label}
                            </span>
                        )}
                    </Fragment>
                )
            })}
        </nav>
    )
}

export default Breadcrumb
