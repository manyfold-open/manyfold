import type { FC, HTMLAttributes, ReactNode } from 'react'
import { cn } from './classNames'

export type HeadingLevel = 1 | 2 | 3 | 4

const sizeClass: Record<HeadingLevel, string> = {
    1: 'text-[20px] leading-[1.2]',
    2: 'text-[18px] leading-[1.25]',
    3: 'text-[15px] leading-[1.35]',
    4: 'text-[14px] leading-[1.35]'
}

interface Props extends HTMLAttributes<HTMLHeadingElement> {
    level?: HeadingLevel
    tone?: 'default' | 'dark'
    children: ReactNode
}

export const Heading: FC<Props> = ({
    level = 2,
    tone = 'default',
    className,
    children,
    ...rest
}): ReactNode => {
    const classes = cn(
        sizeClass[level],
        'font-medium',
        tone === 'dark' ? 'text-white' : 'text-heading',
        className
    )
    if (level === 1)
        return (
            <h1 className={classes} {...rest}>
                {children}
            </h1>
        )
    if (level === 2)
        return (
            <h2 className={classes} {...rest}>
                {children}
            </h2>
        )
    if (level === 3)
        return (
            <h3 className={classes} {...rest}>
                {children}
            </h3>
        )
    return (
        <h4 className={classes} {...rest}>
            {children}
        </h4>
    )
}
