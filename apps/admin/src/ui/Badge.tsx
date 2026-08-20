import type { FC, ReactNode } from 'react'
import { cn } from './classNames'

export type BadgeTone = 'success' | 'neutral' | 'brand' | 'warning' | 'error'

const tones: Record<BadgeTone, string> = {
    success: 'bg-success-bg text-success-text border-success-ring',
    neutral: 'bg-white text-heading border-[#f6f9fc]',
    brand: 'bg-brand-subtle text-brand border-brand-light',
    warning: 'bg-accent-lemon/10 text-accent-lemon border-accent-lemon/30',
    error: 'bg-accent-ruby/10 text-accent-ruby border-accent-ruby/30'
}

interface Props {
    tone?: BadgeTone
    children: ReactNode
    className?: string
}

export const Badge: FC<Props> = ({
    tone = 'neutral',
    children,
    className
}): ReactNode => (
    <span
        className={cn(
            'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-normal tracking-wide',
            tones[tone],
            className
        )}
    >
        {children}
    </span>
)
