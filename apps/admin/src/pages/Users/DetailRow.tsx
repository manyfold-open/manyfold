import type { FC, ReactNode } from 'react'

export const DetailRow: FC<{
    label: string
    value: ReactNode
    mono?: boolean
}> = ({ label, value, mono }): ReactNode => (
    <div className='border-border grid grid-cols-3 gap-2 border-b px-2 py-1 last:border-0'>
        <dt className='text-caption text-label font-normal'>{label}</dt>
        <dd
            className={[
                'text-caption text-heading col-span-2 break-all',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value ?? '-'}
        </dd>
    </div>
)
