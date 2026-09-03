import type { AgentContextDocStatus } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import { Ghost } from '@/components/Loading'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDateTime } from '@/lib/dateFormat'

interface Props {
    agent: SdkAgent
}

const statusLabel = (s: AgentContextDocStatus): string => {
    if (!s.installed) return t('web.agents.detail.contextDoc.notInstalled')
    return s.upToDate
        ? t('web.agents.detail.contextDoc.upToDate')
        : t('web.agents.detail.contextDoc.updateAvailable')
}

export const AgentContextDoc: FC<Props> = ({ agent }) => {
    const client = useApiClient()
    const [status, setStatus] = useState<AgentContextDocStatus | null>(null)
    const [loading, setLoading] = useState(true)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const load = useCallback(async (): Promise<void> => {
        setLoading(true)
        setError(null)
        try {
            setStatus(await client.agents.contextDoc(agent.id))
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [client, agent.id])

    useEffect(() => {
        void load()
    }, [load])

    const install = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            setStatus(await client.agents.refreshContextDoc(agent.id))
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    // Service frameworks never mount this pane: the section gate hides the
    // context doc for them with a framework precondition (#781).

    return (
        <section>
            <header className='mb-4 flex flex-wrap items-start justify-between gap-3'>
                <div className='min-w-0'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                        <h2 className='text-h3 text-fg tracking-tight'>
                            {t('web.agents.detail.contextDoc.title')}
                        </h2>
                        <span className='flex-1' />
                        <EffectTimingTag timing='next-turn' />
                    </div>
                    <p className='text-caption text-muted mt-1.5'>
                        {t('web.agents.detail.contextDoc.descriptionPrefix')}{' '}
                        <code>AGENTS.manyfold.md</code>{' '}
                        {t('web.agents.detail.contextDoc.descriptionSuffix')}
                    </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                    <button
                        type='button'
                        className='workbench-button-secondary'
                        disabled={loading || busy}
                        onClick={() => void load()}
                    >
                        {t('web.agents.detail.contextDoc.recheck')}
                    </button>
                    <button
                        type='button'
                        className='workbench-button-primary'
                        disabled={loading || busy || !status?.agentRunning}
                        onClick={() => void install()}
                    >
                        {busy
                            ? t('web.agents.detail.contextDoc.working')
                            : status?.installed
                              ? t('web.agents.detail.contextDoc.update')
                              : t('web.agents.detail.contextDoc.install')}
                    </button>
                </div>
            </header>

            {error ? (
                <div className='workbench-alert-error mb-4'>{error}</div>
            ) : null}

            {loading || !status ? (
                <div
                    className='workbench-panel divide-divider divide-y overflow-hidden'
                    aria-busy='true'
                >
                    {[0, 1, 2].map((row) => (
                        <div
                            key={row}
                            className='flex items-center justify-between gap-3 px-4 py-3'
                        >
                            <Ghost variant='cap' className='w-24' />
                            <Ghost variant='cap' className='w-32' />
                        </div>
                    ))}
                </div>
            ) : !status.supported ? (
                <p className='text-ui text-muted'>
                    {t('web.agents.detail.contextDoc.notAvailable')}
                </p>
            ) : (
                <>
                    <dl className='workbench-panel divide-divider divide-y overflow-hidden'>
                        <Row
                            label={t('web.agents.detail.status')}
                            value={statusLabel(status)}
                        />
                        <Row
                            label={t(
                                'web.agents.detail.contextDoc.installedVersion'
                            )}
                            value={
                                status.version != null ? `v${status.version}` : '—'
                            }
                        />
                        <Row
                            label={t(
                                'web.agents.detail.contextDoc.currentVersion'
                            )}
                            value={`v${status.currentVersion}`}
                        />
                        <Row
                            label={t('web.agents.detail.contextDoc.generated')}
                            value={formatDateTime(status.generatedAt)}
                        />
                    </dl>
                    {!status.agentRunning ? (
                        <p className='text-caption text-muted mt-2'>
                            {t(
                                'web.agents.detail.contextDoc.startAgentHint'
                            )}
                        </p>
                    ) : null}
                </>
            )}
        </section>
    )
}

const Row: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
    <div className='grid gap-2 px-5 py-4 md:grid-cols-[11rem_minmax(0,1fr)] md:items-baseline'>
        <dt className='text-caption text-subtle'>
            {label}
        </dt>
        <dd className='text-ui text-fg break-all'>{value}</dd>
    </div>
)
