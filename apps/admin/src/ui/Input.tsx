import type { FC, InputHTMLAttributes, ReactNode } from 'react'
import { cn } from './classNames'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
    id: string
    label?: string
    hint?: string
    error?: string
}

const inputClass =
    'block w-full h-8 rounded border border-border bg-white px-2 text-caption text-heading placeholder:text-body/50 transition-colors focus:outline-none focus:border-brand focus:ring-1 focus:ring-brand'

export const Input: FC<Props> = ({
    id,
    label,
    hint,
    error,
    className,
    ...rest
}): ReactNode => (
    <div>
        {label && (
            <label
                htmlFor={id}
                className='text-caption text-label mb-1 block font-normal'
            >
                {label}
            </label>
        )}
        <input
            id={id}
            className={cn(
                inputClass,
                error &&
                    'border-accent-ruby focus:border-accent-ruby focus:ring-accent-ruby',
                className
            )}
            {...rest}
        />
        {error ? (
            <p className='text-caption-sm text-accent-ruby mt-1'>{error}</p>
        ) : hint ? (
            <p className='text-caption-sm text-body mt-1'>{hint}</p>
        ) : null}
    </div>
)
