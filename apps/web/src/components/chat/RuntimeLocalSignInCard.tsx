import { useEffect, useRef } from 'react'
import type { FC, ReactNode } from 'react'
import type { AgentModelConfigView } from '@manyfold/shared'
import { Spinner } from '@/components/Loading'
import { useI18n } from '@/lib/i18n'
import { runtimeSignInCommandFor } from '@/lib/runtimeSignIn'

interface Props {
    view: AgentModelConfigView
    refreshing: boolean
    onRefresh: () => void
    onOpenTerminal: () => void
}

export const RuntimeLocalSignInCard: FC<Props> = ({
    view,
    refreshing,
    onRefresh,
    onOpenTerminal
}): ReactNode => {
    const { t } = useI18n()
    const probedRef = useRef(false)
    const needsFirstProbe =
        view.runtimeLocal == null || view.runtimeLocal.lastCheckedAt == null
    useEffect(() => {
        // One automatic probe so a target that is already signed in (an
        // existing sandbox or computer) resolves to ready without a click,
        // and a fresh agent shows "missing" instead of "not checked".
        if (!needsFirstProbe || probedRef.current || refreshing) return
        probedRef.current = true
        onRefresh()
    }, [needsFirstProbe, onRefresh, refreshing])

    const command = runtimeSignInCommandFor(view.framework)
    const hint =
        view.framework === 'claude-code'
            ? t('web.chat.runtimeSignIn.claudeHint')
            : view.framework === 'codex'
              ? t('web.chat.runtimeSignIn.codexHint')
              : t('web.chat.runtimeSignIn.geminiHint')
    const status = refreshing
        ? t('web.chat.runtimeSignIn.checking')
        : view.runtimeLocal?.credentialStatus === 'expired'
          ? t('web.credentials.runtimeLocal.credentialsExpired')
          : t('web.credentials.runtimeLocal.credentialsMissing')

    return (
        <div className='shadow-ring-light bg-surface/85 rounded-md px-3.5 py-3'>
            <div className='text-ui text-fg font-medium'>
                {t('web.chat.runtimeSignIn.title')}
            </div>
            <p className='text-caption text-muted mt-1'>
                {t('web.chat.runtimeSignIn.body')}
            </p>
            {command && (
                <p className='text-caption text-muted mt-1.5'>
                    <code className='text-fg bg-surface shadow-ring-light rounded px-1.5 py-0.5 font-mono'>
                        {command}
                    </code>{' '}
                    {hint}
                </p>
            )}
            <div className='mt-2.5 flex flex-wrap items-center gap-2'>
                <button
                    type='button'
                    className='workbench-button-primary'
                    onClick={onOpenTerminal}
                >
                    {t('web.chat.runtimeSignIn.openTerminal')}
                </button>
                <button
                    type='button'
                    className='workbench-button-secondary'
                    disabled={refreshing}
                    onClick={onRefresh}
                >
                    {refreshing && <Spinner size={12} />}
                    {t('web.chat.runtimeSignIn.refresh')}
                </button>
                <span className='text-caption text-subtle'>{status}</span>
            </div>
            {view.runtimeLocal?.error && (
                <p className='text-caption text-muted mt-1.5'>
                    {view.runtimeLocal.error}
                </p>
            )}
        </div>
    )
}
