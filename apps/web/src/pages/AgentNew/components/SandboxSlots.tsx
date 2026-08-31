import type { AgentFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { FrameworkLogo } from '@/lib/frameworkMeta'

// Slots use foreground-alpha fills, not fixed colors or borders: an alpha
// overlay keeps a constant relative contrast across the row's rest/hover/
// selected background swaps (a fixed fill blends into one of them), and flips
// automatically in dark mode. Occupied and empty share the same fill; the only
// distinction is the framework logo. Small square radius to echo its shape.
const slotBase =
    'flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]'

// What a sandbox already runs: one slot per co-resident framework (its logo).
export const SandboxSlots: FC<{
    frameworks: AgentFramework[]
    frameworkLabelFor: (framework: AgentFramework) => string
}> = ({ frameworks, frameworkLabelFor }): ReactNode => {
    if (frameworks.length === 0) return null
    return (
        <span
            className='flex shrink-0 items-center gap-1'
            role='img'
            aria-label={frameworks.map(frameworkLabelFor).join(', ')}
        >
            {frameworks.map((f) => (
                <span key={f} className={`${slotBase} bg-fg/[0.05]`}>
                    <FrameworkLogo framework={f} size={13} />
                </span>
            ))}
        </span>
    )
}
