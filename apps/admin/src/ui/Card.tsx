import type { FC, HTMLAttributes, ReactNode } from 'react'
import { cn } from './classNames'

export type CardElevation = 'flat' | 'ambient' | 'card' | 'elevated' | 'deep'

const elevations: Record<CardElevation, string> = {
    flat: '',
    ambient: 'shadow-ambient',
    card: 'shadow-card',
    elevated: 'shadow-elevated',
    deep: 'shadow-deep'
}

interface Props extends HTMLAttributes<HTMLDivElement> {
    elevation?: CardElevation
    children: ReactNode
}

export const Card: FC<Props> = ({
    elevation = 'card',
    className,
    children,
    ...rest
}): ReactNode => (
    <div
        className={cn(
            'border-border rounded-lg border bg-white',
            elevations[elevation],
            className
        )}
        {...rest}
    >
        {children}
    </div>
)

export const CardBody: FC<HTMLAttributes<HTMLDivElement>> = ({
    className,
    children,
    ...rest
}): ReactNode => (
    <div className={cn('p-2', className)} {...rest}>
        {children}
    </div>
)
