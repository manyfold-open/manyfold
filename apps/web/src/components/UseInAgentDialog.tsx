import type { FC, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '@/components/Loading'
import ProductDialog from '@/components/ProductDialog'
import { CheckIcon } from '@/components/icons'
import type { AgentConnection } from '@/hooks/useAgentConnection'
import { hasNewSignIn } from '@/lib/agentConnection'
import { useI18n } from '@/lib/i18n'
import { useAgentSetupPrompt } from '@/lib/useAgentSetupPrompt'

// Long enough to install mf and open a browser, short enough that someone
// whose agent never opened one is not left watching a spinner.
const STUCK_AFTER_MS = 120_000

type StepState = 'todo' | 'now' | 'done'

const Step: FC<{
    state: StepState
    index: number
    title: string
    hint?: string
}> = ({ state, index, title, hint }): ReactNode => (
    <li className='flex items-start gap-2.5'>
        {state === 'done' ? (
            <span className='bg-fg text-main rounded-pill mt-px flex h-5 w-5 shrink-0 items-center justify-center'>
                <CheckIcon className='h-3 w-3' strokeWidth={3} />
            </span>
        ) : state === 'now' ? (
            <span className='text-muted mt-px flex h-5 w-5 shrink-0 items-center justify-center'>
                <Spinner size={16} />
            </span>
        ) : (
            <span className='text-caption text-subtle ring-subtle/60 rounded-pill mt-px flex h-5 w-5 shrink-0 items-center justify-center ring-1 ring-inset'>
                {index}
            </span>
        )}
        <span className='min-w-0'>
            <span
                className={[
                    'text-ui block font-medium',
                    state === 'todo' ? 'text-subtle' : 'text-fg'
                ].join(' ')}
            >
                {title}
            </span>
            {hint && (
                <span className='text-caption text-muted mt-0.5 block'>
                    {hint}
                </span>
            )}
        </span>
    </li>
)

const UseInAgentDialog: FC<{
    connection: AgentConnection
    onClose: () => void
}> = ({ connection, onClose }): ReactNode => {
    const { t } = useI18n()
    const { prompt, promptRef, copied, copy } = useAgentSetupPrompt()
    const { summary } = connection
    const copyRef = useRef<HTMLButtonElement | null>(null)
    const doneRef = useRef<HTMLButtonElement | null>(null)
    // Sign-ins that already existed when the dialog opened. A new one is the
    // agent this dialog just connected, which also covers a second agent
    // opened from "Connect another agent".
    const [knownIds, setKnownIds] = useState<ReadonlySet<string> | null>(null)
    const [copiedAt, setCopiedAt] = useState<number | null>(null)
    const [stuck, setStuck] = useState(false)

    const connected =
        knownIds !== null && summary !== null && hasNewSignIn(summary, knownIds)

    useEffect(() => {
        copyRef.current?.focus()
    }, [])

    useEffect(() => {
        if (knownIds || !summary) return
        setKnownIds(new Set(summary.signIns.map((token) => token.id)))
    }, [knownIds, summary])

    useEffect(() => {
        if (copied && copiedAt === null) setCopiedAt(Date.now())
    }, [copied, copiedAt])

    useEffect(() => {
        if (copiedAt === null || connected) return
        const timer = window.setTimeout(
            () => setStuck(true),
            Math.max(0, STUCK_AFTER_MS - (Date.now() - copiedAt))
        )
        return () => window.clearTimeout(timer)
    }, [copiedAt, connected])

    useEffect(() => {
        if (connected) doneRef.current?.focus()
    }, [connected])

    if (connected)
        return (
            <ProductDialog
                title={t('web.useInAgent.connectedTitle')}
                description={t('web.useInAgent.connectedDescription')}
                size='md'
                onClose={onClose}
                bodyClassName='flex flex-col gap-3'
                footer={
                    <button
                        ref={doneRef}
                        type='button'
                        onClick={onClose}
                        className='workbench-button-primary text-ui ml-auto h-9 shrink-0 px-4'
                    >
                        {t('common.done')}
                    </button>
                }
            >
                <p
                    dir='auto'
                    className='bg-surface-subtle border-divider text-ui text-fg rounded-md border px-3 py-2.5 font-mono'
                >
                    {t('web.useInAgent.tryPrompt')}
                </p>
            </ProductDialog>
        )

    const waiting = copiedAt !== null

    return (
        <ProductDialog
            title={t('web.useInAgent.title')}
            description={t('web.useInAgent.description')}
            size='md'
            onClose={onClose}
            bodyClassName='flex flex-col gap-4'
            footer={
                <>
                    <p className='text-caption text-muted mr-auto'>
                        {waiting
                            ? t('web.useInAgent.waitingHint')
                            : t('web.useInAgent.hint')}
                    </p>
                    <button
                        ref={copyRef}
                        type='button'
                        onClick={() => {
                            void copy()
                        }}
                        className='workbench-button-primary text-ui h-9 shrink-0 px-4'
                    >
                        {copied ? t('common.copied') : t('common.copy')}
                    </button>
                </>
            }
        >
            <p
                ref={promptRef}
                dir='auto'
                className='bg-surface-subtle border-divider text-ui text-fg whitespace-pre-wrap break-words rounded-md border px-3 py-2.5'
            >
                {prompt}
            </p>
            <ol className='flex flex-col gap-3' aria-live='polite'>
                <Step
                    state={waiting ? 'done' : 'todo'}
                    index={1}
                    title={
                        waiting
                            ? t('web.useInAgent.stepCopied')
                            : t('web.useInAgent.stepPaste')
                    }
                />
                <Step
                    state={waiting ? 'now' : 'todo'}
                    index={2}
                    title={t('web.useInAgent.stepApprove')}
                    hint={
                        waiting ? t('web.useInAgent.stepApproveHint') : undefined
                    }
                />
                <Step
                    state='todo'
                    index={3}
                    title={t('web.useInAgent.stepConnected')}
                />
            </ol>
            {stuck && (
                <p className='bg-soft/60 text-caption text-muted rounded-sm px-3 py-2'>
                    {t('web.useInAgent.stuck')}
                </p>
            )}
        </ProductDialog>
    )
}

export default UseInAgentDialog
