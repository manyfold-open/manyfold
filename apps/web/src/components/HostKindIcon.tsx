import type { AgentRuntime } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import {
    BoxIcon,
    CloudComputerIcon,
    GlobeIcon,
    LocalDaemonIcon,
    type LucideIcon
} from '@/components/icons'
import { placementLabel } from '@/lib/hostStatus'

// One glyph per kind of machine, so the runtimes page and the chat header
// draw a sandbox, an own computer and a cloud computer the same way.
export const HOST_KIND_ICON: Record<AgentRuntime, LucideIcon> = {
    daemon: LocalDaemonIcon,
    sprites: BoxIcon,
    k8s: CloudComputerIcon,
    external: GlobeIcon
}

const HostKindIcon: FC<{ kind: AgentRuntime; className?: string }> = ({
    kind,
    className
}): ReactNode => {
    const Icon = HOST_KIND_ICON[kind]
    return (
        <Icon
            role='img'
            aria-label={placementLabel(kind)}
            className={className}
        />
    )
}

export default HostKindIcon
