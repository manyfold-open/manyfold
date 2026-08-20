import type { CatalogSort } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'

interface CatalogSortTabsProps {
    value: CatalogSort
    onChange: (sort: CatalogSort) => void
}

const CatalogSortTabs: FC<CatalogSortTabsProps> = ({
    value,
    onChange
}): ReactNode => {
    const { t } = useI18n()
    const options: { key: CatalogSort; label: string }[] = [
        { key: 'featured', label: t('web.customize.sortFeatured') },
        { key: 'latest', label: t('web.customize.sortLatest') }
    ]
    return (
        <div className='bg-soft shadow-ring-light inline-flex gap-1 rounded-md p-1'>
            {options.map((option) => (
                <button
                    key={option.key}
                    type='button'
                    onClick={() => onChange(option.key)}
                    className={[
                        'text-caption inline-flex h-7 items-center rounded-sm px-3 font-medium transition-colors',
                        value === option.key
                            ? 'bg-surface text-fg shadow-ring-light'
                            : 'text-muted hover:bg-surface-hover'
                    ].join(' ')}
                >
                    {option.label}
                </button>
            ))}
        </div>
    )
}

export default CatalogSortTabs
