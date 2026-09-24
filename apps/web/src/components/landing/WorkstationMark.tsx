import type { WorldMark } from './WorldAgent'

/* Editions slot (§3.3): the mark on the fourth desk of the landing world's
   coding cluster. The open-source build draws a plain terminal prompt, any
   CLI's; a distribution shadows this module by path. */
export const WorkstationMark: WorldMark = ({ size = 15, x = 0, y = 0 }) => (
    <svg
        x={x}
        y={y}
        width={size}
        height={size}
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
    >
        <path d='m4 17 6-6-6-6' />
        <path d='M12 19h8' />
    </svg>
)
