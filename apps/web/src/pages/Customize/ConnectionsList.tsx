import type { UserConnectionSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import EmptyState from '@/components/EmptyState'
import { GhostSettingsRows } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { ChevronRightIcon, PlugIcon, PlusIcon } from '@/components/icons'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { formatDate } from '@/lib/dateFormat'
import { useI18n } from '@/lib/i18n'
import CustomizePageHeader from './CustomizePageHeader'
import CreateConnectionDialog from './CreateConnectionDialog'
import {
    boundConnectionId,
    CONNECTION_PROVIDERS,
    ConnectionProviderIcon,
    connectionProviderLabel
} from './connectionMeta'

const ConnectionsList: FC = (): ReactNode => {
    const client = useApiClient()
    const { t } = useI18n()
    const navigate = useNavigate()
    const [params, setParams] = useSearchParams()
    const [connections, setConnections] = useState<UserConnectionSummary[]>([])
    const [agents, setAgents] = useState<SdkAgent[] | null>(null)
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)
    const [error, setError] = useState<string | null>(null)
    const [banner, setBanner] = useState<string | null>(null)
    const [callbackError, setCallbackError] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setConnections(await client.connections.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    // Bound-agent counts are decoration, so a failed agent list leaves the
    // badges off rather than failing the page.
    useEffect(() => {
        let cancelled = false
        client.agents
            .list()
            .then((items) => {
                if (!cancelled) setAgents(items)
            })
            .catch(() => {
                if (!cancelled) setAgents(null)
            })
        return () => {
            cancelled = true
        }
    }, [client])

    // Surface the GitHub callback outcome, then strip the query params.
    useEffect(() => {
        const connected = params.get('connected')
        const errored = params.get('error')
        if (!connected && !errored) return
        if (connected === 'github')
            setBanner(t('web.customize.connectionsCallbackSuccess'))
        if (errored === 'github') {
            const reason = params.get('reason')
            setCallbackError(
                reason
                    ? t('web.customize.connectionsCallbackErrorReason', {
                          reason
                      })
                    : t('web.customize.connectionsCallbackError')
            )
        }
        const next = new URLSearchParams(params)
        next.delete('connected')
        next.delete('error')
        next.delete('reason')
        setParams(next, { replace: true })
    }, [params, setParams, t])

    const sorted = useMemo(
        () =>
            [...connections].sort((a, b) => {
                const byProvider =
                    CONNECTION_PROVIDERS.indexOf(a.provider) -
                    CONNECTION_PROVIDERS.indexOf(b.provider)
                if (byProvider !== 0) return byProvider
                return a.displayName.localeCompare(b.displayName)
            }),
        [connections]
    )

    const boundCounts = useMemo(() => {
        const counts = new Map<string, number>()
        for (const agent of agents ?? []) {
            for (const provider of CONNECTION_PROVIDERS) {
                const id = boundConnectionId(agent, provider)
                if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
            }
        }
        return counts
    }, [agents])

    const boundBadge = (connectionId: string): ReactNode => {
        if (!agents) return null
        const count = boundCounts.get(connectionId) ?? 0
        if (count === 0)
            return (
                <span className='tag tag-idle'>
                    <span className='tag-dot' />
                    {t('web.customize.connectionsUnbound')}
                </span>
            )
        return (
            <span className='tag tag-success'>
                <span className='tag-dot' />
                {count === 1
                    ? t('web.customize.connectionsBoundOne')
                    : t('web.customize.connectionsBoundMany', { count })}
            </span>
        )
    }

    return (
        <>
            <CustomizePageHeader
                group='connections'
                action={
                    <button
                        type='button'
                        onClick={() => setCreateOpen(true)}
                        className='workbench-button-primary shrink-0 gap-1.5'
                    >
                        <PlusIcon className='h-4 w-4' />
                        {t('web.customize.connectionsNew')}
                    </button>
                }
            />

            {error && <div className='workbench-alert-error mb-5'>{error}</div>}
            {banner && (
                <div className='workbench-alert-success mb-5'>{banner}</div>
            )}
            {callbackError && (
                <div className='workbench-alert-error mb-5'>
                    {callbackError}
                </div>
            )}

            {gate.showLoading && (
                <section className='settings-card' aria-busy='true'>
                    <GhostSettingsRows rows={3} />
                </section>
            )}

            {!gate.showLoading && sorted.length > 0 && (
                <section
                    className={
                        gate.fadeIn
                            ? 'settings-card loading-fade-in'
                            : 'settings-card'
                    }
                >
                    {sorted.map((connection) => (
                        <Link
                            key={connection.id}
                            to={`/connections/${connection.id}`}
                            className='settings-card-row hover:bg-surface-hover group transition-colors'
                        >
                            <div className='flex min-w-0 items-start gap-3'>
                                <ConnectionProviderIcon
                                    provider={connection.provider}
                                    className='text-fg mt-0.5 h-6 w-6 shrink-0'
                                />
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {connection.displayName}
                                    </div>
                                    <div className='text-caption text-muted mt-1.5 flex flex-wrap items-center gap-1.5'>
                                        <span>
                                            {connectionProviderLabel(
                                                connection.provider
                                            )}
                                        </span>
                                        {connection.externalId && (
                                            <>
                                                <span>·</span>
                                                <span className='tag tag-neutral font-mono'>
                                                    {connection.externalId}
                                                </span>
                                            </>
                                        )}
                                        <span>·</span>
                                        <span>
                                            {formatDate(connection.updatedAt)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className='settings-card-side'>
                                {boundBadge(connection.id)}
                                <ChevronRightIcon className='text-subtle group-hover:text-fg h-4 w-4 transition-colors' />
                            </div>
                        </Link>
                    ))}
                </section>
            )}

            {/* The header's New connection button is the one creation action,
                so the first-use state carries none — Skills and MCP spend
                theirs on a catalog link Connections has no equivalent for. */}
            {!gate.showLoading && sorted.length === 0 && !error && (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    icon={PlugIcon}
                    title={t('web.emptyState.connectionsTitle')}
                    body={t('web.emptyState.connectionsBody')}
                />
            )}

            {createOpen && (
                <CreateConnectionDialog
                    onClose={() => setCreateOpen(false)}
                    onCreated={(id) => {
                        setCreateOpen(false)
                        void refresh()
                        navigate(`/connections/${id}`)
                    }}
                />
            )}
        </>
    )
}

export default ConnectionsList
