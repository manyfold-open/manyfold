import type { FC, ReactNode } from 'react'

type BrandMarkProps = {
    className?: string
}

export const BrandMark: FC<BrandMarkProps> = ({ className }): ReactNode => (
    <svg
        className={className}
        viewBox='0 0 135 100'
        aria-hidden='true'
        focusable='false'
    >
        <polygon points='10,80 35,15 47.5,15 22.5,80' fill='currentColor' />
        <polygon
            points='35,15 60,80 47.5,15 72.5,80'
            fill='rgb(var(--color-muted))'
        />
        <polygon points='60,80 85,15 72.5,80 97.5,15' fill='currentColor' />
        <polygon
            points='85,15 110,80 97.5,15 122.5,80'
            fill='rgb(var(--color-muted))'
        />
    </svg>
)
