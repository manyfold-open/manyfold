import type { AgentFramework, DaemonHostSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { CheckIcon, CopyIcon, ExternalLinkIcon } from '@/components/icons'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { apiBaseUrl } from '@/lib/apiClient'
import {
    daemonInstallCommand,
    daemonRegisterCommand,
    daemonSetupCommand
} from '@/lib/daemonCommands'
import { docsHref } from '@/lib/docsLinks'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

export const DaemonStatusDot: FC<{ online: boolean }> = ({
    online
}): ReactNode => {
    const { t } = useI18n()
    return (
        <ShortcutTooltip
            label={t(
                online
                    ? 'web.connectDaemon.online'
                    : 'web.connectDaemon.offline'
            )}
        >
            <span
                className={
                    online
                        ? 'inline-block h-2 w-2 shrink-0 rounded-full bg-emerald-500'
                        : 'inline-block h-2 w-2 shrink-0 rounded-full bg-zinc-400'
                }
            />
        </ShortcutTooltip>
    )
}

export const DaemonFrameworkTags: FC<{
    host: DaemonHostSummary
    highlight?: AgentFramework
}> = ({ host, highlight }): ReactNode => {
    const { t } = useI18n()
    return host.detectedFrameworks.length > 0 ? (
        <span className='flex flex-wrap gap-1'>
            {host.detectedFrameworks.map((f) => (
                <span
                    key={f.framework}
                    className={[
                        'tag',
                        f.framework === highlight
                            ? 'tag-success'
                            : 'tag-neutral'
                    ].join(' ')}
                >
                    {frameworkLabel(f.framework)}
                </span>
            ))}
        </span>
    ) : (
        <span className='text-subtle text-caption'>
            {t('web.connectDaemon.noneDetected')}
        </span>
    )
}

// `wrap` shows the full command across lines instead of truncating. The
// token-based rows (settings) truncate because a long `ldt_…` token is noise;
// the token-less setup command is short and readable, and the whole point of
// the dialog is to copy it — so it's shown in full.
const CommandRow: FC<{
    command: string
    onCopy?: () => void
    wrap?: boolean
}> = ({ command, onCopy, wrap = false }): ReactNode => {
    const { t } = useI18n()
    const [copied, setCopied] = useState(false)
    const copy = (): void => {
        void navigator.clipboard.writeText(command)
        setCopied(true)
        onCopy?.()
    }
    return (
        <div
            className={[
                'bg-surface-subtle flex gap-2 rounded-md px-3 py-2.5',
                wrap ? 'items-start' : 'items-center'
            ].join(' ')}
        >
            <code
                className={[
                    'text-fg text-caption min-w-0 flex-1 font-mono',
                    wrap ? 'break-all leading-relaxed' : 'truncate'
                ].join(' ')}
            >
                {command}
            </code>
            <button
                type='button'
                onClick={copy}
                aria-label={t('web.connectDaemon.copy')}
                className={[
                    'text-subtle hover:text-fg inline-flex shrink-0 items-center gap-1 transition-colors',
                    wrap ? 'mt-0.5' : ''
                ].join(' ')}
            >
                {copied ? (
                    <CheckIcon className='text-success h-4 w-4' />
                ) : (
                    <CopyIcon className='h-4 w-4' />
                )}
            </button>
        </div>
    )
}

// The token-less connect flow for the quick "connect a new computer" dialog:
// one command shown in full (no secret to hide), with the platform note as a
// caption right under it. What the command *does* lives in the dialog's
// description; the Windows guide link lives in the dialog footer.
// `DaemonConnectCommands` (below) stays for the settings surface, where naming
// and issuing a token is the explicit task.
export const DaemonSetupCommand: FC<{ onCopy?: () => void }> = ({
    onCopy
}): ReactNode => {
    const { t } = useI18n()
    return (
        <div>
            <CommandRow
                command={daemonSetupCommand(apiBaseUrl())}
                onCopy={onCopy}
                wrap
            />
            <p className='text-subtle text-caption mt-1.5'>
                {t('web.connectDaemon.cmdPlatform')}
            </p>
        </div>
    )
}

// Single source of truth for the connect commands, shown wherever we hand the
// user a daemon token (create-agent dialog + settings). Both cases are listed
// rather than toggled: the labels let the user self-select without an extra
// interaction, and there are only two lines.
export const DaemonConnectCommands: FC<{
    token: string
    onCopy?: () => void
}> = ({ token, onCopy }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='flex flex-col gap-3'>
            <div>
                <p className='text-fg text-caption mb-1.5 font-medium'>
                    {t('web.connectDaemon.cmdInstallLabel')}
                </p>
                <CommandRow
                    command={daemonInstallCommand(token, apiBaseUrl())}
                    onCopy={onCopy}
                />
                <p className='text-subtle text-caption mt-1.5'>
                    {t('web.connectDaemon.cmdInstallNote')}{' '}
                    <a
                        href={docsHref('/docs/install')}
                        target='_blank'
                        rel='noreferrer'
                        className='text-link hover:text-fg inline-flex items-center gap-1'
                    >
                        {t('web.connectDaemon.windowsGuide')}
                        <ExternalLinkIcon className='h-3 w-3' />
                    </a>
                </p>
            </div>
            <div>
                <p className='text-fg text-caption mb-1.5 font-medium'>
                    {t('web.connectDaemon.cmdRegisterLabel')}
                </p>
                <CommandRow
                    command={daemonRegisterCommand(token, apiBaseUrl())}
                    onCopy={onCopy}
                />
                <p className='text-subtle text-caption mt-1.5'>
                    {t('web.connectDaemon.cmdRegisterNote')}
                </p>
            </div>
            <p className='text-subtle text-caption'>
                {t('web.connectDaemon.tokenOnce')}
            </p>
        </div>
    )
}
