import type { FC, HTMLAttributes, ReactNode } from 'react'
import { cn } from './classNames'

export const DetailPage: FC<HTMLAttributes<HTMLDivElement>> = ({
    className,
    children,
    ...rest
}): ReactNode => (
    <div className={cn('mx-auto max-w-none', className)} {...rest}>
        {children}
    </div>
)
