import type { FC, ReactNode } from 'react'
import type { BreadcrumbItem } from '@/components/Breadcrumb'
import Breadcrumb from '@/components/Breadcrumb'

interface SettingsPageHeaderProps {
    title: string
    breadcrumb?: BreadcrumbItem[]
    description?: ReactNode
    actions?: ReactNode
}

const SettingsPageHeader: FC<SettingsPageHeaderProps> = ({
    title,
    breadcrumb,
    description,
    actions
}): ReactNode => {
    const hasBreadcrumb = Boolean(breadcrumb && breadcrumb.length > 0)
    const mobileEmpty = !hasBreadcrumb && !description && !actions
    return (
        <header
            className={[
                'settings-page-header',
                mobileEmpty ? 'hidden lg:block' : ''
            ].join(' ')}
        >
            {breadcrumb && breadcrumb.length > 0 && (
                <Breadcrumb items={breadcrumb} />
            )}
            <div className='settings-page-header-row'>
                <div className='min-w-0'>
                    <h1 className='text-h1 text-fg hidden lg:block'>
                        {title}
                    </h1>
                    {description && (
                        <p className='settings-section-copy mt-2 mb-0'>
                            {description}
                        </p>
                    )}
                </div>
                {actions && (
                    <div className='settings-page-header-actions'>
                        {actions}
                    </div>
                )}
            </div>
        </header>
    )
}

export default SettingsPageHeader
