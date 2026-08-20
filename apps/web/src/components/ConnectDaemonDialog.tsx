import type {
    AgentFramework,
    DaemonHostSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ProductDialog from '@/components/ProductDialog'
import {
    DaemonFrameworkTags,
    DaemonSetupCommand,
    DaemonStatusDot
} from '@/components/DaemonShared'
import {
    CheckIcon,
    CloseIcon,
    EditIcon,
    ExternalLinkIcon,
    InfoIcon
} from '@/components/icons'
import { Spinner } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { docsHref } from '@/lib/docsLinks'
import { frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

interface Props {
    framework: AgentFramework
    onClose: () => void
    onConnected: (host: DaemonHostSummary) => void | Promise<void>
}

type Step = 'run' | 'use'

const POLL_MS = 4000

const hostDetects = (host: DaemonHostSummary, fw: AgentFramework): boolean =>
    host.detectedFrameworks.some((f) => f.framework === fw)

const ConnectDaemonDialog: FC<Props> = ({
    framework,
    onClose,
    onConnected
}): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [hosts, setHosts] = useState<DaemonHostSummary[]>([])
    const [step, setStep] = useState<Step>('run')
    const [ready, setReady] = useState(false)
    const [selectedHostId, setSelectedHostId] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [editingName, setEditingName] = useState(false)
    const [nameDraft, setNameDraft] = useState('')
    const [savingName, setSavingName] = useState(false)
    const knownRef = useRef<Set<string>>(new Set())
    const snapshotRef = useRef(false)

    const fwLabel = frameworkLabel(framework)

    // The command is token-less and static, so there's nothing to issue — we
    // only snapshot the machines that already exist so the poller can tell
    // which one is the fresh connection. Gate detection on `ready` so an
    // already-connected machine isn't mistaken for the new one before the
    // snapshot lands.
    useEffect(() => {
        if (snapshotRef.current) return
        snapshotRef.current = true
        void (async (): Promise<void> => {
            const rows = await client.daemons.listHosts().catch(() => [])
            knownRef.current = new Set(rows.map((h) => h.id))
            setHosts(rows)
            setReady(true)
        })()
    }, [client])

    // Keep the machine list live so online status and detected frameworks
    // stay current across both steps.
    useEffect(() => {
        let cancelled = false
        const poll = async (): Promise<void> => {
            const rows = await client.daemons.listHosts().catch(() => null)
            if (cancelled || !rows) return
            setHosts(rows)
        }
        const id = setInterval(() => void poll(), POLL_MS)
        return () => {
            cancelled = true
            clearInterval(id)
        }
    }, [client])

    // When a brand-new machine comes online, jump to the connected step.
    useEffect(() => {
        if (step !== 'run' || !ready) return
        const fresh = hosts.find(
            (h) => !knownRef.current.has(h.id) && h.online
        )
        if (fresh) {
            setSelectedHostId(fresh.id)
            setStep('use')
        }
    }, [step, ready, hosts])

    const selectedHost = useMemo(
        () => hosts.find((h) => h.id === selectedHostId) ?? null,
        [hosts, selectedHostId]
    )

    const startRename = (): void => {
        if (!selectedHost) return
        setNameDraft(selectedHost.name)
        setEditingName(true)
    }

    const saveRename = async (): Promise<void> => {
        if (!selectedHost) return
        const next = nameDraft.trim()
        if (!next || next === selectedHost.name) {
            setEditingName(false)
            return
        }
        setSavingName(true)
        try {
            const updated = await client.daemons.renameHost(
                selectedHost.id,
                next
            )
            setHosts((prev) =>
                prev.map((h) => (h.id === updated.id ? updated : h))
            )
            setEditingName(false)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSavingName(false)
        }
    }

    const learnHowLink = (
        <a
            href={docsHref('/docs/local-daemons')}
            target='_blank'
            rel='noreferrer'
            className='text-subtle hover:text-fg text-caption inline-flex items-center gap-1'
        >
            {t('web.connectDaemon.learnHow')}
            <ExternalLinkIcon className='h-3 w-3' />
        </a>
    )

    // Help links sit together in the footer's left rail — one group of
    // supporting exits, so the footer reads "help on the left, action on the
    // right" instead of scattering links through the body.
    const helpLinks = (
        <span className='mr-auto flex flex-wrap items-center gap-x-4 gap-y-1'>
            <a
                href={docsHref('/docs/install')}
                target='_blank'
                rel='noreferrer'
                className='text-subtle hover:text-fg text-caption inline-flex items-center gap-1'
            >
                {t('web.connectDaemon.windowsGuide')}
                <ExternalLinkIcon className='h-3 w-3' />
            </a>
            {learnHowLink}
        </span>
    )

    const renderRun = (): ReactNode => (
        <>
            <DaemonSetupCommand />
            <div className='bg-surface-subtle text-subtle text-caption flex items-center gap-2 rounded-md px-3 py-2.5'>
                <Spinner size={12} className='shrink-0' />
                {t('web.connectDaemon.waiting')}
            </div>
        </>
    )

    const renderUse = (): ReactNode => {
        if (!selectedHost) return null
        const detected = hostDetects(selectedHost, framework)
        return (
            <>
                <div className='bg-success-bg text-success-strong flex items-center gap-2 rounded-md px-3 py-2.5'>
                    <CheckIcon className='h-4 w-4 shrink-0' />
                    <span className='text-caption min-w-0 truncate font-medium'>
                        {t('web.connectDaemon.connectedBanner', {
                            name: selectedHost.name
                        })}
                    </span>
                </div>
                <div className='bg-surface-subtle shadow-ring-light rounded-md px-3 py-2.5'>
                    <span className='flex min-w-0 items-center gap-2'>
                        <DaemonStatusDot online={selectedHost.online} />
                        {editingName ? (
                            <>
                                <input
                                    autoFocus
                                    value={nameDraft}
                                    onChange={(e) =>
                                        setNameDraft(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void saveRename()
                                        if (e.key === 'Escape')
                                            setEditingName(false)
                                    }}
                                    maxLength={64}
                                    disabled={savingName}
                                    className='workbench-input h-7 min-w-0 flex-1 py-1 text-ui'
                                />
                                <button
                                    type='button'
                                    onClick={() => void saveRename()}
                                    disabled={savingName}
                                    aria-label={t('web.connectDaemon.renameSave')}
                                    className='text-subtle hover:text-fg shrink-0'
                                >
                                    <CheckIcon className='h-4 w-4' />
                                </button>
                                <button
                                    type='button'
                                    onClick={() => setEditingName(false)}
                                    disabled={savingName}
                                    aria-label={t('web.agentNew.cancel')}
                                    className='text-subtle hover:text-fg shrink-0'
                                >
                                    <CloseIcon className='h-4 w-4' />
                                </button>
                            </>
                        ) : (
                            <>
                                <span className='text-fg text-ui min-w-0 truncate font-medium'>
                                    {selectedHost.name}
                                </span>
                                <button
                                    type='button'
                                    onClick={startRename}
                                    aria-label={t('web.connectDaemon.renameAria')}
                                    className='text-subtle hover:text-fg shrink-0'
                                >
                                    <EditIcon className='h-3.5 w-3.5' />
                                </button>
                                <span className='text-subtle text-caption ml-auto shrink-0'>
                                    {selectedHost.os ?? '?'}/
                                    {selectedHost.arch ?? '?'}
                                </span>
                            </>
                        )}
                    </span>
                </div>

                <div>
                    <span className='text-subtle text-caption mb-1.5 block'>
                        {t('web.connectDaemon.detectedLabel')}
                    </span>
                    <DaemonFrameworkTags
                        host={selectedHost}
                        highlight={framework}
                    />
                </div>

                {!detected && (
                    <div className='bg-warning-bg text-fg shadow-ring-light rounded-md px-3 py-2.5'>
                        <p className='text-caption inline-flex items-center gap-1.5 font-medium'>
                            <InfoIcon className='h-3.5 w-3.5 shrink-0' />
                            {t('web.connectDaemon.frameworkMissingTitle', {
                                framework: fwLabel,
                                name: selectedHost.name
                            })}
                        </p>
                        <p className='text-caption mt-1 inline-flex items-center gap-1.5'>
                            <Spinner size={12} className='shrink-0' />
                            {t('web.connectDaemon.frameworkMissingHint', {
                                framework: fwLabel
                            })}
                        </p>
                    </div>
                )}
            </>
        )
    }

    const footer = ((): ReactNode => {
        if (step === 'use') {
            const detected = selectedHost
                ? hostDetects(selectedHost, framework)
                : false
            return (
                <>
                    <span className='mr-auto'>{learnHowLink}</span>
                    <button
                        type='button'
                        onClick={() => setStep('run')}
                        className='workbench-button-secondary text-ui h-9 px-3'
                    >
                        {t('web.connectDaemon.back')}
                    </button>
                    <button
                        type='button'
                        disabled={!selectedHost || !detected || editingName}
                        onClick={() =>
                            selectedHost && void onConnected(selectedHost)
                        }
                        className='workbench-button-primary text-ui h-9 px-4'
                    >
                        {t('web.connectDaemon.use')}
                    </button>
                </>
            )
        }
        return (
            <>
                {helpLinks}
                <button
                    type='button'
                    onClick={onClose}
                    className='workbench-button-secondary text-ui h-9 px-3'
                >
                    {t('web.connectDaemon.close')}
                </button>
            </>
        )
    })()

    return (
        <ProductDialog
            title={t('web.connectDaemon.titleRegister')}
            description={step === 'run' ? t('web.connectDaemon.desc') : undefined}
            size='sm'
            onClose={onClose}
            bodyClassName='flex flex-col gap-4'
            footer={footer}
        >
            {step === 'run' && renderRun()}
            {step === 'use' && renderUse()}

            {error && <p className='text-error text-caption'>{error}</p>}
        </ProductDialog>
    )
}

export default ConnectDaemonDialog
