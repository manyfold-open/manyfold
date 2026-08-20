import {
    CloudflareConnectionResourcesResponse,
    CloudflareResourceSection,
    ComposioToolSummary,
    ConnectionProvider,
    GithubConnectionReposResponse,
    UserConnectionSummary,
    frameworkCapability
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import Breadcrumb from '@/components/Breadcrumb'
import { ArrowLeftIcon, RefreshIcon } from '@/components/icons'
import { Ghost, SheenText } from '@/components/Loading'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ProductDialog from '@/components/ProductDialog'
import AgentPicker from '@/pages/Automations/AgentPicker'
import { useApiClient } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/dateFormat'
import { apiErrorMessage } from '@/lib/errorMessage'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import {
    bindPatch,
    connectionExtrasKey,
    ConnectionProviderIcon,
    connectionProviderLabel,
    connectionRef
} from './connectionMeta'

const COMPOSIO_DASHBOARD_URL = 'https://platform.composio.dev'

const manageLabel = (provider: ConnectionProvider): string =>
    provider === 'github'
        ? t('web.customize.connectionDetail.manageRepoAccess')
        : t('web.customize.connectionDetail.manageToken')

const DetailItem: FC<{ label: string; value: string }> = ({ label, value }) => (
    <div>
        <dt className='text-mini text-muted'>{label}</dt>
        <dd className='text-ui text-fg break-words'>{value}</dd>
    </div>
)

const PanelNote: FC<{ children: ReactNode }> = ({ children }) => (
    <p className='text-ui text-muted'>{children}</p>
)

const RenameConnectionDialog: FC<{
    connection: UserConnectionSummary
    onClose: () => void
    onRenamed: () => Promise<void>
}> = ({ connection, onClose, onRenamed }): ReactNode => {
    const client = useApiClient()
    const [name, setName] = useState(connection.displayName)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const trimmed = name.trim()
    const canSubmit =
        !busy && trimmed.length > 0 && trimmed !== connection.displayName

    const handleSubmit = async (e: FormEvent): Promise<void> => {
        e.preventDefault()
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        try {
            await client.connections.rename(connection.id, { name: trimmed })
            await onRenamed()
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err))
            setBusy(false)
        }
    }

    return (
        <ProductDialog
            title={t('web.customize.connectionDetail.renameTitle')}
            onClose={onClose}
            onSubmit={handleSubmit}
            closeDisabled={busy}
            size='sm'
            footer={
                <>
                    <button
                        type='button'
                        onClick={onClose}
                        className='workbench-button-secondary'
                        disabled={busy}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type='submit'
                        className='workbench-button-primary'
                        disabled={!canSubmit}
                    >
                        {busy ? t('common.saving') : t('common.save')}
                    </button>
                </>
            }
        >
            {error && <div className='workbench-alert-error'>{error}</div>}
            <input
                className='workbench-input'
                value={name}
                autoFocus
                spellCheck={false}
                autoComplete='off'
                onChange={(e) => setName(e.target.value)}
            />
        </ProductDialog>
    )
}

const GithubPanel: FC<{ connectionId: string; reloadKey: number }> = ({
    connectionId,
    reloadKey
}): ReactNode => {
    const client = useApiClient()
    const [data, setData] = useState<GithubConnectionReposResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let alive = true
        setLoading(true)
        setError(null)
        void client.connections
            .githubRepos(connectionId)
            .then((res) => {
                if (!alive) return
                setData(res)
            })
            .catch((err) => {
                if (!alive) return
                setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (alive) setLoading(false)
            })
        return () => {
            alive = false
        }
    }, [client, connectionId, reloadKey])

    const selectionNote =
        data?.repositorySelection === 'all'
            ? t('web.customize.connectionDetail.allRepositories')
            : t('web.customize.connectionDetail.selectedRepositories', {
                  count: data?.totalCount ?? 0
              })

    return (
        <section className='workbench-panel mb-6 px-5 py-4'>
            <div className='mb-2 flex items-center justify-between'>
                <div className='workbench-kicker'>
                    {t('web.customize.connectionDetail.repositories')}
                </div>
                {data ? (
                    <span className='text-ui text-muted'>{selectionNote}</span>
                ) : null}
            </div>
            {loading ? (
                <SheenText className='text-ui text-muted'>
                    {t('web.customize.connectionDetail.loadingRepositories')}
                </SheenText>
            ) : error ? (
                <div className='workbench-alert-error'>{error}</div>
            ) : !data || data.repos.length === 0 ? (
                <PanelNote>
                    {t('web.customize.connectionDetail.noRepositories')}
                </PanelNote>
            ) : (
                <>
                    <ul className='divide-divider divide-y'>
                        {data.repos.map((repo) => (
                            <li
                                key={repo.fullName}
                                className='flex items-center justify-between gap-3 py-2.5'
                            >
                                <div className='min-w-0'>
                                    <a
                                        className='text-ui text-fg truncate font-medium hover:underline'
                                        href={repo.htmlUrl}
                                        target='_blank'
                                        rel='noreferrer'
                                    >
                                        {repo.fullName}
                                    </a>
                                    <p className='text-caption text-muted'>
                                        {repo.defaultBranch}
                                        {repo.pushedAt
                                            ? t(
                                                  'web.customize.connectionDetail.pushedAt',
                                                  {
                                                      date: formatDateTime(
                                                          repo.pushedAt
                                                      )
                                                  }
                                              )
                                            : ''}
                                    </p>
                                </div>
                                {repo.private ? (
                                    <span className='text-caption text-muted bg-soft shrink-0 rounded-full px-2 py-0.5'>
                                        {t(
                                            'web.customize.connectionDetail.private'
                                        )}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                    {data.repos.length < data.totalCount ? (
                        <p className='text-caption text-muted mt-2'>
                            {t(
                                'web.customize.connectionDetail.showingRepositories',
                                {
                                    shown: data.repos.length,
                                    total: data.totalCount
                                }
                            )}
                        </p>
                    ) : null}
                </>
            )}
        </section>
    )
}

interface CloudflareSectionProps<T extends { name: string }> {
    title: string
    section: CloudflareResourceSection<T>
    manageUrl: string | null
    renderItem: (item: T) => ReactNode
}

const CloudflareSection = <T extends { name: string }>({
    title,
    section,
    manageUrl,
    renderItem
}: CloudflareSectionProps<T>): ReactNode => (
    <div>
        <h3 className='text-ui text-fg mb-1 font-medium'>{title}</h3>
        {section.status === 'error' ? (
            <PanelNote>
                {t('web.customize.connectionDetail.couldNotLoad', {
                    resource: title.toLowerCase()
                })}
            </PanelNote>
        ) : section.status === 'forbidden' ? (
            <PanelNote>
                {t('web.customize.connectionDetail.tokenLacksPermission', {
                    resource: title
                })}{' '}
                {manageUrl ? (
                    <a
                        className='underline'
                        href={manageUrl}
                        target='_blank'
                        rel='noreferrer'
                    >
                        {t('web.customize.connectionDetail.manageToken')}
                    </a>
                ) : null}
            </PanelNote>
        ) : section.items.length === 0 ? (
            <PanelNote>
                {t('web.customize.connectionDetail.noResources', {
                    resource: title.toLowerCase()
                })}
            </PanelNote>
        ) : (
            <ul className='divide-divider divide-y'>
                {section.items.map((item) => (
                    <li key={item.name} className='py-2.5'>
                        {renderItem(item)}
                    </li>
                ))}
            </ul>
        )}
    </div>
)

const CloudflarePanel: FC<{
    connection: UserConnectionSummary
    reloadKey: number
}> = ({ connection, reloadKey }): ReactNode => {
    const client = useApiClient()
    const [data, setData] =
        useState<CloudflareConnectionResourcesResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let alive = true
        setLoading(true)
        setError(null)
        void client.connections
            .cloudflareResources(connection.id)
            .then((res) => {
                if (!alive) return
                setData(res)
            })
            .catch((err) => {
                if (!alive) return
                setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (alive) setLoading(false)
            })
        return () => {
            alive = false
        }
    }, [client, connection.id, reloadKey])

    const dashBase = data ? `https://dash.cloudflare.com/${data.accountId}` : ''

    return (
        <section className='workbench-panel mb-6 px-5 py-4'>
            <div className='mb-2 flex items-center justify-between'>
                <div className='workbench-kicker'>
                    {t('web.customize.connectionDetail.cloudflareResources')}
                </div>
                {data ? (
                    <span
                        className={[
                            'text-ui',
                            data.tokenStatus === 'active'
                                ? 'text-muted'
                                : 'text-workflow-ship'
                        ].join(' ')}
                    >
                        {t('web.customize.connectionDetail.tokenStatus', {
                            status: data.tokenStatus
                        })}
                    </span>
                ) : null}
            </div>
            {loading ? (
                <SheenText className='text-ui text-muted'>
                    {t('web.customize.connectionDetail.loadingWorkersPages')}
                </SheenText>
            ) : error ? (
                <div className='workbench-alert-error'>{error}</div>
            ) : !data ? null : (
                <div className='space-y-4'>
                    <CloudflareSection
                        title={t('web.customize.connectionDetail.workers')}
                        section={data.workers}
                        manageUrl={connection.manageUrl}
                        renderItem={(worker: {
                            name: string
                            modifiedOn: string | null
                        }) => (
                            <div className='flex items-center justify-between gap-3'>
                                <a
                                    className='text-ui text-fg min-w-0 truncate font-medium hover:underline'
                                    href={`${dashBase}/workers/services/view/${encodeURIComponent(worker.name)}`}
                                    target='_blank'
                                    rel='noreferrer'
                                >
                                    {worker.name}
                                </a>
                                {worker.modifiedOn ? (
                                    <span className='text-caption text-muted shrink-0'>
                                        {t(
                                            'web.customize.connectionDetail.updatedAt',
                                            {
                                                date: formatDateTime(
                                                    worker.modifiedOn
                                                )
                                            }
                                        )}
                                    </span>
                                ) : null}
                            </div>
                        )}
                    />
                    <CloudflareSection
                        title={t('web.customize.connectionDetail.pages')}
                        section={data.pages}
                        manageUrl={connection.manageUrl}
                        renderItem={(project: {
                            name: string
                            domains: string[]
                            latestDeployedAt: string | null
                        }) => (
                            <div className='flex items-center justify-between gap-3'>
                                <div className='min-w-0'>
                                    <a
                                        className='text-ui text-fg truncate font-medium hover:underline'
                                        href={`${dashBase}/pages/view/${encodeURIComponent(project.name)}`}
                                        target='_blank'
                                        rel='noreferrer'
                                    >
                                        {project.name}
                                    </a>
                                    {project.domains.length > 0 ? (
                                        <p className='text-caption text-muted truncate'>
                                            {project.domains.join(' · ')}
                                        </p>
                                    ) : null}
                                </div>
                                {project.latestDeployedAt ? (
                                    <span className='text-caption text-muted shrink-0'>
                                        {t(
                                            'web.customize.connectionDetail.deployedAt',
                                            {
                                                date: formatDateTime(
                                                    project.latestDeployedAt
                                                )
                                            }
                                        )}
                                    </span>
                                ) : null}
                            </div>
                        )}
                    />
                </div>
            )}
        </section>
    )
}

const ComposioPanel: FC<{ connectionId: string; reloadKey: number }> = ({
    connectionId,
    reloadKey
}): ReactNode => {
    const client = useApiClient()
    const [tools, setTools] = useState<ComposioToolSummary[] | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [revealedKey, setRevealedKey] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        let alive = true
        setLoading(true)
        setError(null)
        void client.connections
            .composioTools(connectionId)
            .then((res) => {
                if (!alive) return
                setTools(res.tools)
            })
            .catch((err) => {
                if (!alive) return
                setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (alive) setLoading(false)
            })
        return () => {
            alive = false
        }
    }, [client, connectionId, reloadKey])

    const toggleReveal = async (): Promise<void> => {
        if (revealedKey) {
            setRevealedKey(null)
            return
        }
        try {
            const { apiKey } = await client.connections.reveal(connectionId)
            setRevealedKey(apiKey)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    const copyKey = async (): Promise<void> => {
        if (!revealedKey) return
        await navigator.clipboard.writeText(revealedKey)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
    }

    return (
        <>
            <section className='workbench-panel mb-6 px-5 py-4'>
                <div className='mb-2 flex items-center justify-between'>
                    <div className='workbench-kicker'>
                        {t('web.customize.connectionDetail.mcpTools')}
                    </div>
                    <span className='text-ui text-muted'>
                        {tools
                            ? t('web.customize.connectionDetail.exposedTools', {
                                  count: tools.length
                              })
                            : ''}
                    </span>
                </div>
                <p className='text-caption text-muted mb-3'>
                    {t(
                        'web.customize.connectionDetail.composioToolsDescription'
                    )}{' '}
                    <a
                        className='underline'
                        href={COMPOSIO_DASHBOARD_URL}
                        target='_blank'
                        rel='noreferrer'
                    >
                        {t('web.customize.connectionDetail.composioDashboard')}
                    </a>
                    .
                </p>
                {loading ? (
                    <SheenText className='text-ui text-muted'>
                        {t('web.customize.connectionDetail.loadingTools')}
                    </SheenText>
                ) : error ? (
                    <div className='workbench-alert-error'>{error}</div>
                ) : !tools || tools.length === 0 ? (
                    <PanelNote>
                        {t('web.customize.connectionDetail.noTools')}
                    </PanelNote>
                ) : (
                    <ul className='divide-divider divide-y'>
                        {tools.map((tool) => (
                            <li key={tool.name} className='py-2.5'>
                                <p className='text-ui text-fg break-all font-mono'>
                                    {tool.name}
                                </p>
                                {tool.description ? (
                                    <p className='text-caption text-muted mt-0.5 line-clamp-2'>
                                        {tool.description}
                                    </p>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className='workbench-panel mb-6 px-5 py-4'>
                <div className='workbench-kicker mb-2'>
                    {t('web.customize.connectionDetail.connectApiKey')}
                </div>
                <div className='flex items-center gap-2'>
                    <code className='text-ui text-fg bg-soft min-w-0 flex-1 truncate rounded px-3 py-2'>
                        {revealedKey ?? '••••••••••••••••'}
                    </code>
                    <button
                        type='button'
                        onClick={() => void toggleReveal()}
                        className='workbench-button-ghost h-8 shrink-0 px-3'
                    >
                        {revealedKey
                            ? t('web.customize.connectionDetail.hide')
                            : t('web.customize.connectionDetail.show')}
                    </button>
                    {revealedKey ? (
                        <button
                            type='button'
                            onClick={() => void copyKey()}
                            className='workbench-button-ghost h-8 shrink-0 px-3'
                        >
                            {copied ? t('web.chat.copied') : t('web.chat.copy')}
                        </button>
                    ) : null}
                </div>
            </section>
        </>
    )
}

const LinkedAgentsPanel: FC<{ connection: UserConnectionSummary }> = ({
    connection
}): ReactNode => {
    const client = useApiClient()
    const [agents, setAgents] = useState<SdkAgent[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const extrasKey = connectionExtrasKey(connection.provider)

    useEffect(() => {
        let alive = true
        void client.agents
            .list()
            .then((list) => {
                if (alive) setAgents(list)
            })
            .catch((err) => {
                if (alive) setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (alive) setLoading(false)
            })
        return () => {
            alive = false
        }
    }, [client])

    const bound = useMemo(
        () =>
            agents.filter(
                (agent) => connectionRef(agent, extrasKey) === connection.id
            ),
        [agents, connection.id, extrasKey]
    )
    // Connection env/MCP is injected on CLI-backed agents only; service
    // frameworks (hermes/openclaw/…) don't use this path.
    const bindable = useMemo(
        () =>
            agents.filter(
                (agent) =>
                    frameworkCapability(agent.framework).kind !== 'service' &&
                    connectionRef(agent, extrasKey) !== connection.id
            ),
        [agents, connection.id, extrasKey]
    )

    const update = async (
        agentId: string,
        value: string | null
    ): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const next = await client.agents.update(
                agentId,
                bindPatch(connection.provider, value)
            )
            setAgents((prev) =>
                prev.map((agent) => (agent.id === next.id ? next : agent))
            )
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    return (
        <section className='workbench-panel mb-6 px-5 py-4'>
            <div className='mb-2 flex items-center justify-between'>
                <div className='workbench-kicker'>
                    {t('web.customize.connectionDetail.linkedAgents')}
                </div>
                <span className='text-ui text-muted'>{bound.length}</span>
            </div>
            {error ? (
                <div className='workbench-alert-error mb-3'>{error}</div>
            ) : null}
            {loading ? (
                <SheenText className='text-ui text-muted'>
                    {t('web.customize.connectionDetail.loadingAgents')}
                </SheenText>
            ) : bound.length === 0 ? (
                <PanelNote>
                    {t('web.customize.connectionDetail.noLinkedAgents')}
                </PanelNote>
            ) : (
                <ul className='divide-divider divide-y'>
                    {bound.map((agent) => (
                        <li
                            key={agent.id}
                            className='flex items-center gap-2.5 py-2.5'
                        >
                            <FrameworkLogo
                                framework={agent.framework}
                                size={20}
                                className='shrink-0'
                            />
                            <Link
                                className='text-ui text-fg min-w-0 flex-1 truncate font-medium hover:underline'
                                to={`/agents/${agent.id}`}
                            >
                                {agent.name}
                            </Link>
                            <button
                                type='button'
                                className='workbench-button-ghost h-8 shrink-0 px-3'
                                disabled={busy}
                                onClick={() => void update(agent.id, null)}
                            >
                                {t('web.customize.connectionDetail.unbind')}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {bindable.length > 0 ? (
                <div className='mt-3'>
                    <AgentPicker
                        agents={bindable}
                        selectedAgentId=''
                        placeholder={t(
                            'web.customize.connectionDetail.bindAgentPlaceholder'
                        )}
                        placement='top'
                        disabled={busy}
                        onSelect={(agentId) =>
                            void update(agentId, connection.id)
                        }
                    />
                </div>
            ) : null}
        </section>
    )
}

const ConnectionDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const client = useApiClient()
    const navigate = useNavigate()
    const { confirm, confirmDialog } = useProductConfirm()
    const [connections, setConnections] = useState<UserConnectionSummary[]>([])
    const [loading, setLoading] = useState(true)
    const [renameOpen, setRenameOpen] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reloadKey, setReloadKey] = useState(0)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setConnections(await client.connections.list())
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setLoading(false)
        }
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const connection = connections.find((c) => c.id === id) ?? null

    if (loading && !connection)
        return (
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                <div aria-busy='true'>
                    <Ghost variant='title' className='w-48' />
                    <Ghost variant='cap' className='mt-3 w-72 max-w-full' />
                    <div className='workbench-panel mt-6 space-y-3 px-5 py-5'>
                        <Ghost variant='line' className='w-1/4' />
                        <Ghost variant='cap' className='w-3/5' />
                        <Ghost variant='cap' className='w-2/5' />
                    </div>
                </div>
            </div>
        )
    if (!connection)
        return (
            <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
                <Link to='/connections' className='settings-back-link'>
                    <ArrowLeftIcon className='h-4 w-4' />
                    {t('web.customize.connectionDetail.backToConnections')}
                </Link>
                <div className='workbench-alert-error mt-4'>
                    {t('web.customize.connectionDetail.notFound')}
                </div>
            </div>
        )

    const handleDelete = async (): Promise<void> => {
        const ok = await confirm({
            title: t('web.customize.connectionDetail.removeTitle', {
                provider: connectionProviderLabel(connection.provider)
            }),
            description: t('web.customize.connectionDetail.removeDescription', {
                name: connection.displayName
            }),
            confirmLabel: t('web.customize.connectionDetail.remove'),
            cancelLabel: t('common.cancel'),
            tone: 'danger'
        })
        if (!ok) return
        try {
            await client.connections.delete(connection.id)
            await refresh()
            navigate('/connections')
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }

    const externalIdLabel =
        connection.provider === 'github'
            ? 'web.customize.connectionDetail.installation'
            : 'web.customize.connectionDetail.accountId'

    return (
        <div className='mx-auto w-full max-w-3xl px-5 py-6 md:px-6 md:py-7'>
            <Breadcrumb
                items={[
                    {
                        label: t('web.customize.navConnections'),
                        to: '/connections'
                    },
                    { label: connection.displayName }
                ]}
            />

            <div className='mb-6 flex items-start justify-between gap-4'>
                <div className='flex min-w-0 flex-1 items-center gap-4'>
                    <ConnectionProviderIcon
                        provider={connection.provider}
                        className='h-10 w-10 shrink-0'
                    />
                    <div className='min-w-0'>
                        <h1 className='text-h1 text-fg truncate'>
                            {connection.displayName}
                        </h1>
                        <p className='text-ui text-muted mt-1'>
                            {connectionProviderLabel(connection.provider)}
                            {connection.externalId
                                ? ` · ${connection.externalId}`
                                : ''}
                        </p>
                    </div>
                </div>
                <div className='flex items-center gap-2'>
                    {connection.manageUrl ? (
                        <a
                            className='workbench-button-ghost h-9 px-3'
                            href={connection.manageUrl}
                            target='_blank'
                            rel='noreferrer'
                        >
                            {manageLabel(connection.provider)}
                        </a>
                    ) : null}
                    <button
                        type='button'
                        onClick={() => setReloadKey((k) => k + 1)}
                        className='workbench-button-ghost'
                        aria-label={t('web.agents.detail.refresh')}
                    >
                        <RefreshIcon className='h-4 w-4' />
                    </button>
                    <button
                        type='button'
                        onClick={() => setRenameOpen(true)}
                        className='workbench-button-ghost'
                    >
                        {t('web.customize.connectionDetail.rename')}
                    </button>
                    <button
                        type='button'
                        onClick={() => void handleDelete()}
                        className='workbench-button-danger'
                    >
                        {t('web.customize.connectionDetail.remove')}
                    </button>
                </div>
            </div>

            {error ? (
                <div className='workbench-alert-error mb-4'>{error}</div>
            ) : null}

            <section className='workbench-panel mb-6 px-5 py-4'>
                <div className='workbench-kicker mb-2'>
                    {t('web.customize.connectionDetail.overview')}
                </div>
                <dl className='text-ui text-fg grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3'>
                    <DetailItem
                        label={t('web.customize.connectionDetail.provider')}
                        value={connectionProviderLabel(connection.provider)}
                    />
                    {connection.externalId ? (
                        <DetailItem
                            label={t(externalIdLabel)}
                            value={connection.externalId}
                        />
                    ) : null}
                    <DetailItem
                        label={t('web.customize.connectionDetail.connected')}
                        value={formatDateTime(connection.createdAt)}
                    />
                    <DetailItem
                        label={t('web.customize.connectionDetail.updated')}
                        value={formatDateTime(connection.updatedAt)}
                    />
                </dl>
            </section>

            {connection.provider === 'github' ? (
                <GithubPanel
                    connectionId={connection.id}
                    reloadKey={reloadKey}
                />
            ) : null}
            {connection.provider === 'cloudflare' ? (
                <CloudflarePanel
                    connection={connection}
                    reloadKey={reloadKey}
                />
            ) : null}
            {connection.provider === 'composio' ? (
                <ComposioPanel
                    connectionId={connection.id}
                    reloadKey={reloadKey}
                />
            ) : null}

            <LinkedAgentsPanel connection={connection} />

            {renameOpen ? (
                <RenameConnectionDialog
                    connection={connection}
                    onClose={() => setRenameOpen(false)}
                    onRenamed={refresh}
                />
            ) : null}
            {confirmDialog}
        </div>
    )
}

export default ConnectionDetail
