import { useRef, useState } from 'react'
import type { FC, ReactNode } from 'react'
import type { AgentFramework } from '@manyfold/shared'
import { CopyButton } from '@/components/RuntimeDetailPanel'
import {
    TerminalSession,
    type TerminalConnectionStatus
} from '@/components/TerminalDock'
import { useAppAuth } from '@/lib/auth'
import { useI18n } from '@/lib/i18n'
import { runtimeSignInCommandFor } from '@/lib/runtimeSignIn'

// The runtime page's sign-in shell: a bare host terminal (no agent behind
// it) that starts on the CLI's own sign-in command, so the user only has to
// follow the link it prints and paste the code back. Lazy-loaded by the
// account section so xterm stays out of the settings bundle for everyone who
// only reads usage.
const RuntimeSignInTerminal: FC<{
    runtimeId: string
    framework: AgentFramework
    onDone: () => void
}> = ({ runtimeId, framework, onDone }): ReactNode => {
    const { t } = useI18n()
    const { getToken } = useAppAuth()
    const [sessionId] = useState(() => `signin-${runtimeId}-${Date.now()}`)
    // Only a shell that opened and then ended is "done"; a session that never
    // connected keeps its error and Reconnect affordance on screen.
    const openedRef = useRef(false)
    const command = runtimeSignInCommandFor(framework)
    const hint =
        framework === 'claude-code'
            ? t('web.chat.runtimeSignIn.claudeHint')
            : framework === 'codex'
              ? t('web.chat.runtimeSignIn.codexHint')
              : t('web.chat.runtimeSignIn.geminiHint')
    const handleStatus = (
        _tabId: string,
        status: TerminalConnectionStatus
    ): void => {
        if (status === 'open') openedRef.current = true
        if (status === 'closed' && openedRef.current) onDone()
    }
    return (
        <div className='workbench-panel overflow-hidden'>
            <div className='border-divider/60 flex flex-wrap items-start gap-x-3 gap-y-2 border-b px-4 py-3'>
                <div className='min-w-0 flex-1'>
                    <div className='text-ui text-fg font-medium'>
                        {t('web.runtimeDetails.account.signInBody')}
                    </div>
                    {command && (
                        <p className='text-caption text-muted mt-1 flex flex-wrap items-center gap-1.5'>
                            <code className='text-fg bg-surface shadow-ring-light rounded px-1.5 py-0.5 font-mono'>
                                {command}
                            </code>
                            <CopyButton value={command} />
                            <span>{hint}</span>
                        </p>
                    )}
                </div>
                <button
                    type='button'
                    className='workbench-button-secondary shrink-0'
                    onClick={onDone}
                >
                    {t('web.terminal.closeTab')}
                </button>
            </div>
            <div className='relative h-72'>
                <TerminalSession
                    active
                    tab={{ id: sessionId, runtimeId }}
                    initialInput={command ? `${command}\r` : undefined}
                    getToken={getToken}
                    onStatusChange={handleStatus}
                />
            </div>
        </div>
    )
}

export default RuntimeSignInTerminal
