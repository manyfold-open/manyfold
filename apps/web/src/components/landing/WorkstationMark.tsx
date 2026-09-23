import nexusLightIcon from '@/assets/agent-logos/nexus-light.svg'
import nexusDarkIcon from '@/assets/agent-logos/nexus-dark.svg'
import type { WorldMark } from './WorldAgent'

/* Editions slot (§3.3): the mark on the fourth workstation of the landing
   world. A distribution shadows this module by path.

   @lobehub/icons has no NarraNexus mark, so the world borrows the product's
   own asset — the same two files its framework logo renders everywhere else.
   Two images rather than one tinted mark: the stroke is a black-to-grey
   gradient in light and white-to-grey in dark, which `currentColor` cannot
   express. The nested viewBox crops the file's 738-square canvas to the
   artwork's own band, so the mark fills the head's slot instead of sitting
   at 60% with air above and below. */
export const WorkstationMark: WorldMark = ({ size = 15, x = 0, y = 0 }) => (
    <svg x={x} y={y} width={size} height={size} viewBox='0 149 738 441'>
        <image
            className='dark:hidden'
            href={nexusLightIcon}
            width='738'
            height='738'
        />
        <image
            className='hidden dark:block'
            href={nexusDarkIcon}
            width='738'
            height='738'
        />
    </svg>
)
