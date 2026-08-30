import type { FC, ReactNode } from 'react'
import { useMemo } from 'react'
import { sigilCells } from '@/components/field/fields'

/* An identity mark derived from the id itself, so the same agent always wears
   the same glyph on every surface — the subject field standing for something
   real (§3.4 L7), not a decorative avatar. */
export interface SigilProps {
    seed: string
    size?: number
    cell?: number
    className?: string
}

export const Sigil: FC<SigilProps> = ({
    seed,
    size = 9,
    cell = 3,
    className
}): ReactNode => {
    const cells = useMemo(() => sigilCells(seed, size), [seed, size])
    return (
        <span
            className={className ? `lp-sigil ${className}` : 'lp-sigil'}
            style={{
                gridTemplateColumns: `repeat(${size}, ${cell}px)`,
                gridAutoRows: `${cell}px`
            }}
            aria-hidden='true'
        >
            {cells.map((opacity, i) => (
                <span key={i} style={{ opacity }} />
            ))}
        </span>
    )
}
