import type { FC, ReactNode } from 'react'

/* Discrete cells, not a continuous bar: the data role of Fieldwork quantises
   a real value onto the same lattice the decorative fields use (§3.1 role C).
   A meter always shows a real number — never decoration. */
export interface PixelMeterProps {
    value: number
    of: number
    tone?: 'jade' | 'iris' | 'coral'
    label?: string
    className?: string
}

export const PixelMeter: FC<PixelMeterProps> = ({
    value,
    of,
    tone = 'jade',
    label,
    className
}): ReactNode => {
    const filled = Math.max(0, Math.min(of, Math.round(value)))
    return (
        <div className={className ? `lp-pxrow ${className}` : 'lp-pxrow'}>
            <span className='lp-pxbar' data-tone={tone} aria-hidden='true'>
                {Array.from({ length: of }, (_, i) => (
                    <i key={i} data-on={i < filled ? 'true' : 'false'} />
                ))}
            </span>
            {/* The reading steps one shade lighter than the fill so a column
                of meters does not turn into a block of colour noise. */}
            <span className='lp-pxnum' data-tone={tone}>
                {filled}/{of}
            </span>
            {label ? <span className='lp-pxlabel'>{label}</span> : null}
        </div>
    )
}
