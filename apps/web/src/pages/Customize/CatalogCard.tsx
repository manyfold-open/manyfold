import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Ghost } from '@/components/Loading'
import { Tag } from '@/components/Tag'

interface CatalogCardProps {
    to: string
    name: string
    description?: string | null
    iconUrl?: string | null
    fallbackIcon: ReactNode
    featured: boolean
    featuredLabel: string
    categoryName?: string | null
    tags: string[]
    meta?: ReactNode
    sourceIcon?: ReactNode
}

const CatalogCard: FC<CatalogCardProps> = (props): ReactNode => {
    const [iconFailed, setIconFailed] = useState(false)
    const showImage = !!props.iconUrl && !iconFailed
    return (
        <Link
            to={props.to}
            className='bg-surface shadow-card hover:bg-surface-hover flex flex-col gap-3 rounded-md p-4 transition-colors'
        >
            <div className='flex items-start gap-3'>
                <div className='bg-soft text-subtle flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-sm'>
                    {showImage ? (
                        <img
                            src={props.iconUrl ?? undefined}
                            alt=''
                            className='h-full w-full object-cover'
                            onError={() => setIconFailed(true)}
                        />
                    ) : (
                        props.fallbackIcon
                    )}
                </div>
                <div className='min-w-0 flex-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                        <span className='settings-card-label'>
                            {props.name}
                        </span>
                        {props.featured && (
                            <span className='bg-info-bg text-info-strong text-caption rounded-md px-2 py-0.5'>
                                {props.featuredLabel}
                            </span>
                        )}
                    </div>
                    {props.meta && (
                        <div className='text-caption text-muted mt-0.5 break-words'>
                            {props.meta}
                        </div>
                    )}
                </div>
                {props.sourceIcon && (
                    <div className='text-subtle shrink-0'>{props.sourceIcon}</div>
                )}
            </div>
            {props.description && (
                <p className='text-ui text-muted line-clamp-2'>
                    {props.description}
                </p>
            )}
            {(props.categoryName || props.tags.length > 0) && (
                <div className='mt-auto flex flex-wrap gap-1.5'>
                    {props.categoryName && <Tag>{props.categoryName}</Tag>}
                    {props.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                    ))}
                </div>
            )}
        </Link>
    )
}

// Ghost twin (DESIGN.md §10.8) — lives beside the real card so a layout
// change to one is a same-file, same-PR change to the other. Container
// classes mirror CatalogCard's Link shell minus hover; only content
// slots ghost. Width steps vary by seed so a grid of ghosts reads as
// ragged text, not a brick wall (literal class strings for the Tailwind
// content scan).
const ghostNameWidth = ['w-2/5', 'w-1/3', 'w-1/2']
const ghostMetaWidth = ['w-3/5', 'w-1/2', 'w-2/3']
const ghostDescWidthA = ['w-11/12', 'w-full', 'w-5/6']
const ghostDescWidthB = ['w-2/3', 'w-1/2', 'w-3/4']
const ghostTagWidth = ['w-14', 'w-10', 'w-16']

export const CatalogCardGhost: FC<{ seed?: number }> = ({
    seed = 0
}): ReactNode => (
    <div className='bg-surface shadow-card flex flex-col gap-3 rounded-md p-4'>
        <div className='flex items-start gap-3'>
            <Ghost variant='tile' className='h-8 w-8 shrink-0' />
            <div className='min-w-0 flex-1 pt-0.5'>
                <Ghost variant='line' className={ghostNameWidth[seed % 3]} />
                <Ghost
                    variant='cap'
                    className={['mt-2', ghostMetaWidth[seed % 3]].join(' ')}
                />
            </div>
            <Ghost variant='circle' className='h-4 w-4 shrink-0' />
        </div>
        <div className='flex flex-col gap-1.5'>
            <Ghost variant='cap' className={ghostDescWidthA[seed % 3]} />
            <Ghost variant='cap' className={ghostDescWidthB[seed % 3]} />
        </div>
        <div className='mt-auto flex gap-1.5'>
            <Ghost
                variant='circle'
                className={['h-5', ghostTagWidth[seed % 3]].join(' ')}
            />
            <Ghost
                variant='circle'
                className={['h-5', ghostTagWidth[(seed + 1) % 3]].join(' ')}
            />
        </div>
    </div>
)

export default CatalogCard
