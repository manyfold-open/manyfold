import type { FC, ReactNode } from 'react'
import { useState } from 'react'

interface Props {
    label: string
    meta?: string
    body: ReactNode
    defaultOpen?: boolean
}

const CapabilityBlock: FC<Props> = ({
    label,
    meta,
    body,
    defaultOpen = false
}): ReactNode => {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className='bg-surface-subtle shadow-ring my-2 rounded-md p-3'>
            <button
                type='button'
                onClick={() => setOpen(!open)}
                className='text-ui text-fg hover:bg-surface-hover -mx-2 -my-2 flex w-[calc(100%+1rem)] items-center justify-between rounded px-2 py-2 font-medium transition-colors'
            >
                <span className='flex items-center gap-2'>
                    <span className='text-caption text-muted font-mono'>
                        {label}
                    </span>
                    {meta && (
                        <span className='text-caption text-subtle'>{meta}</span>
                    )}
                </span>
                <span className='text-caption text-subtle'>
                    {open ? '−' : '+'}
                </span>
            </button>
            {open && (
                <div className='text-caption text-muted mt-3 font-mono'>
                    {body}
                </div>
            )}
        </div>
    )
}

export default CapabilityBlock
