import type { VersionedFramework } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

// Per-framework install/upgrade guidance for self-owned (daemon) hosts — we
// never install CLIs on a user's own machine, so we show the command + official
// docs and let the daemon detect it on PATH. Most are npm; hermes ships its own
// install script + `hermes update`.
const FRAMEWORK_INSTALL_GUIDE: Partial<
    Record<
        VersionedFramework,
        { bin: string; install: string; upgrade: string; docs: string }
    >
> = {
    'claude-code': {
        bin: 'claude',
        install: 'npm install -g @anthropic-ai/claude-code',
        upgrade: 'npm install -g @anthropic-ai/claude-code@latest',
        docs: 'https://docs.anthropic.com/en/docs/claude-code/setup'
    },
    codex: {
        bin: 'codex',
        install: 'npm install -g @openai/codex',
        upgrade: 'npm install -g @openai/codex@latest',
        docs: 'https://github.com/openai/codex'
    },
    'gemini-cli': {
        bin: 'gemini',
        install: 'npm install -g @google/gemini-cli',
        upgrade: 'npm install -g @google/gemini-cli@latest',
        docs: 'https://github.com/google-gemini/gemini-cli'
    },
    openclaw: {
        bin: 'openclaw',
        install: 'npm install -g openclaw',
        upgrade: 'npm install -g openclaw@latest',
        docs: 'https://github.com/openclaw/openclaw'
    },
    hermes: {
        bin: 'hermes',
        install:
            'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
        upgrade: 'hermes update',
        docs: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation'
    }
}

// "弹出引导官网" popup for daemon hosts: shows the install/upgrade command + a
// link to the official docs. The daemon detects the CLI automatically once it
// lands on PATH (incl. nvm/fnm/volta, via the login-shell resolver).
const FrameworkInstallGuide: FC<{
    framework: VersionedFramework
    mode: 'install' | 'upgrade'
    hostName: string
    onClose: () => void
}> = ({ framework, mode, hostName, onClose }): ReactNode => {
    const { t } = useI18n()
    const guide = FRAMEWORK_INSTALL_GUIDE[framework]
    const [copied, setCopied] = useState(false)
    if (!guide) return null
    const cmd = mode === 'upgrade' ? guide.upgrade : guide.install
    return (
        <ProductDialog
            title={`${mode === 'upgrade' ? t('web.agentRuntimesList.update') : t('web.agentRuntimesList.install')} ${frameworkLabel(framework)}`}
            description={t('web.agentRuntimesList.guideDescription', {
                host: hostName
            })}
            size='md'
            onClose={onClose}
        >
            <div className='space-y-4'>
                <div>
                    <div className='workbench-kicker mb-2'>
                        {t('web.agentRuntimesList.command')}
                    </div>
                    <div className='flex items-center gap-2'>
                        <code className='text-caption shadow-ring-light bg-surface text-fg min-w-0 flex-1 overflow-x-auto rounded-md px-3 py-2 font-mono'>
                            {cmd}
                        </code>
                        <button
                            type='button'
                            onClick={(): void => {
                                void navigator.clipboard?.writeText(cmd)
                                setCopied(true)
                            }}
                            className='text-ui shadow-ring-light bg-surface hover:bg-surface-hover shrink-0 rounded-md px-3 py-2 font-medium transition-colors'
                        >
                            {copied
                                ? t('web.agentRuntimesList.copied')
                                : t('web.agentRuntimesList.copy')}
                        </button>
                    </div>
                </div>
                <a
                    href={guide.docs}
                    target='_blank'
                    rel='noreferrer'
                    className='text-link hover:text-fg text-ui inline-flex items-center gap-1 font-medium'
                >
                    {t('web.agentRuntimesList.officialGuide')}
                </a>
                <p className='text-caption text-muted'>
                    {t('web.agentRuntimesList.guideInstallMethods')}
                </p>
            </div>
        </ProductDialog>
    )
}

export default FrameworkInstallGuide
