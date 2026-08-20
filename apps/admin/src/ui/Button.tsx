import type { ButtonHTMLAttributes, FC, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { cn } from './classNames'

export type ButtonVariant = 'primary' | 'ghost' | 'info' | 'neutral'
export type ButtonSize = 'md' | 'sm'

const base =
    'inline-flex items-center justify-center whitespace-nowrap rounded font-normal transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2'

const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand text-white hover:bg-brand-hover',
    ghost: 'bg-transparent text-brand border border-brand-light hover:bg-brand-subtle',
    info: 'bg-transparent text-[#2874ad] border border-[rgba(43,145,223,0.2)] hover:bg-[rgba(43,145,223,0.05)]',
    neutral:
        'bg-transparent text-body/60 border border-border hover:bg-surface-muted'
}

const sizes: Record<ButtonSize, string> = {
    md: 'h-8 px-2.5 text-caption',
    sm: 'h-7 px-2.5 text-caption-sm'
}

interface CommonProps {
    variant?: ButtonVariant
    size?: ButtonSize
    className?: string
    children: ReactNode
}

type ButtonProps = CommonProps &
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>

export const Button: FC<ButtonProps> = ({
    variant = 'primary',
    size = 'md',
    className,
    children,
    type = 'button',
    ...rest
}): ReactNode => (
    <button
        type={type}
        className={cn(base, variants[variant], sizes[size], className)}
        {...rest}
    >
        {children}
    </button>
)

type ButtonLinkProps = CommonProps & Omit<LinkProps, 'className' | 'children'>

export const ButtonLink: FC<ButtonLinkProps> = ({
    variant = 'primary',
    size = 'md',
    className,
    children,
    ...rest
}): ReactNode => (
    <Link
        className={cn(base, variants[variant], sizes[size], className)}
        {...rest}
    >
        {children}
    </Link>
)
