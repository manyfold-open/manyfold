import type { SdkAgent } from '@manyfold/sdk'
import type { FC, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import HostKindIcon from '@/components/HostKindIcon'
import { FolderIcon } from '@/components/icons'
import PathPopover from '@/components/PathPopover'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { hostKey, placementLabel } from '@/lib/hostStatus'
import { useI18n } from '@/lib/i18n'
import { navigateWithRailTransition } from '@/lib/railTransition'
import { workspaceDirNameOf, workspacePathOf } from '@/lib/workspacePath'

// Where an agent runs and what it works in, one type size below its name: the
// machine opens its own settings, the folder shows its basename and opens the
// full path on hover or on a tap. The chat header and the agent's overview both
// draw it, so the two read the same. An agent with no machine has neither.
const AgentPlaceLine: FC<{
    agent: SdkAgent
    // A fact about the machine, set after its name ("kept awake").
    note?: string
    className?: string
}> = ({ agent, note, className }): ReactNode => {
    const { t } = useI18n()
    const navigate = useNavigate()
    if (agent.hostId === null) return null
    const hostPath = `/settings/runtimes?host=${hostKey(agent.hostId)}`
    const dirName = workspaceDirNameOf(agent)
    const separator = (
        <span aria-hidden='true' className='text-placeholder'>
            ·
        </span>
    )
    return (
        <div
            className={[
                'text-caption text-muted flex min-w-0 items-center gap-1.5',
                className ?? ''
            ].join(' ')}
        >
            <ShortcutTooltip
                label={placementLabel(agent.runtime)}
                placement='bottom-start'
                className='min-w-0 shrink'
            >
                <Link
                    to={hostPath}
                    onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
                        // Leaving the area takes the rail transition; a
                        // modified click still opens a tab the browser's way.
                        if (
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                        )
                            return
                        event.preventDefault()
                        navigateWithRailTransition(navigate, hostPath, 'forward')
                    }}
                    className='hover:bg-soft -mx-1 inline-flex min-w-0 items-center gap-1 rounded-sm px-1 transition-colors'
                >
                    <HostKindIcon
                        kind={agent.runtime}
                        className='h-3 w-3 shrink-0'
                    />
                    <span className='truncate font-mono'>
                        {agent.hostName ?? agent.hostId}
                    </span>
                </Link>
            </ShortcutTooltip>
            {note ? (
                <>
                    {separator}
                    <span className='shrink-0'>{note}</span>
                </>
            ) : null}
            {dirName ? (
                <>
                    {separator}
                    <PathPopover
                        path={workspacePathOf(agent)}
                        label={t('web.agents.detail.workspace')}
                        copyLabel={t('web.agents.detail.copyWorkspacePath')}
                        className='hover:bg-soft aria-expanded:bg-soft -mx-1 inline-flex min-w-0 items-center gap-1 rounded-sm px-1 transition-colors'
                    >
                        <FolderIcon
                            aria-hidden='true'
                            className='h-3 w-3 shrink-0'
                        />
                        <span className='truncate font-mono'>{dirName}</span>
                    </PathPopover>
                </>
            ) : null}
        </div>
    )
}

export default AgentPlaceLine
