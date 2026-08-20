import {
    AgentCreateStep,
    AgentRuntimeSummary,
    AgentStatus,
    SdkUserSummary,
    frameworkUpgradeMode,
    isUpgradeableFramework,
    isVersionedFramework,
    k8sSteps,
    spritesSteps
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import type { SdkAgent } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { useCurrentUser } from '@/lib/useCurrentUser'
import { adminRoutes } from '@/routes'
import {
    Badge,
    type BadgeTone,
    Breadcrumbs,
    Button,
    Card,
    CardBody,
    DetailPage,
    Heading
} from '@/ui'
import { CreateProgress } from './components/CreateProgress'
import AgentSessionsCard from './components/AgentSessionsCard'
import FilesTab from './components/FilesTab'
import UsageTab from './components/UsageTab'
import { AgentModelConfigPanel } from './components/AgentModelConfigPanel'

type DetailTab = 'overview' | 'files' | 'usage' | 'model'

const stepsFor = (agent: SdkAgent): AgentCreateStep[] =>
    agent.runtime === 'sprites' ? spritesSteps : k8sSteps

const isKnownStep = (
    phase: string | null,
    steps: AgentCreateStep[]
): phase is AgentCreateStep =>
    phase !== null && (steps as string[]).includes(phase)

const statusTone: Record<AgentStatus, BadgeTone> = {
    pending: 'warning',
    running: 'success',
    stopped: 'neutral',
    failed: 'error'
}

const formatDate = (value: string | null): string =>
    value ? new Date(value).toLocaleString(getLocale()) : '—'

const Row: FC<{ label: string; value: ReactNode; mono?: boolean }> = ({
    label,
    value,
    mono
}): ReactNode => (
    <div className='border-border grid grid-cols-3 gap-2 border-b px-2 py-1 last:border-0'>
        <dt className='text-caption text-label font-normal'>{label}</dt>
        <dd
            className={[
                'text-caption text-heading col-span-2 break-all',
                mono ? 'font-mono' : ''
            ].join(' ')}
        >
            {value ?? '—'}
        </dd>
    </div>
)

const AgentDetail: FC = (): ReactNode => {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const client = useApiClient()
    const { isAdmin, loading: userLoading } = useCurrentUser()
    const agentsApi = isAdmin ? client.admin.agents : client.agents
    const runtimesApi = isAdmin
        ? client.admin.agentRuntimes
        : client.agentRuntimes
    const [agent, setAgent] = useState<SdkAgent | null>(null)
    const [runtime, setRuntime] = useState<AgentRuntimeSummary | null>(null)
    const [owner, setOwner] = useState<SdkUserSummary | null>(null)
    const [notFound, setNotFound] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [tab, setTab] = useState<DetailTab>('overview')
    const [deleting, setDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState<string | null>(null)
    const [internalsOpen, setInternalsOpen] = useState(false)
    const [fwRefreshing, setFwRefreshing] = useState(false)
    const [fwUpgrading, setFwUpgrading] = useState(false)
    const [fwError, setFwError] = useState<string | null>(null)
    const [fwPickerOpen, setFwPickerOpen] = useState(false)
    const [fwVersions, setFwVersions] = useState<string[] | null>(null)
    const [fwTarget, setFwTarget] = useState<string>('')
    const [fwStep, setFwStep] = useState<string | null>(null)

    const handleRefreshFrameworkVersion = async (): Promise<void> => {
        if (!agent || fwRefreshing) return
        setFwRefreshing(true)
        setFwError(null)
        try {
            setAgent(await agentsApi.refreshFrameworkVersion(agent.id))
        } catch (err) {
            setFwError((err as Error).message)
        } finally {
            setFwRefreshing(false)
        }
    }

    const handleOpenVersionPicker = async (): Promise<void> => {
        setFwPickerOpen(true)
        setFwError(null)
        if (fwVersions || !agent) return
        try {
            const catalog = await client.frameworkVersions.get(agent.framework)
            setFwVersions(catalog.versions)
            setFwTarget(
                agent.frameworkLatestVersion ??
                    catalog.latest ??
                    catalog.versions[0] ??
                    ''
            )
        } catch (err) {
            setFwError((err as Error).message)
        }
    }

    const handleUpgradeFramework = async (): Promise<void> => {
        if (!agent || !fwTarget || fwUpgrading) return
        setFwUpgrading(true)
        setFwError(null)
        setFwStep(null)
        try {
            if (frameworkUpgradeMode(agent.framework) === 'rebuild') {
                setAgent(
                    await agentsApi.upgradeFrameworkStream(
                        agent.id,
                        fwTarget,
                        (ev) => {
                            if (ev.type === 'step') setFwStep(ev.step)
                        }
                    )
                )
            } else {
                setAgent(await agentsApi.upgradeFramework(agent.id, fwTarget))
            }
            setFwPickerOpen(false)
        } catch (err) {
            setFwError((err as Error).message)
        } finally {
            setFwUpgrading(false)
            setFwStep(null)
        }
    }

    const handleDelete = async (): Promise<void> => {
        if (!agent) return
        if (
            !window.confirm(
                `${t('admin.agents.detail.delete.confirm')}\n\n${agent.name}`
            )
        )
            return
        setDeleting(true)
        setDeleteError(null)
        try {
            await agentsApi.delete(agent.id)
            navigate(adminRoutes.agents)
        } catch (err) {
            setDeleteError((err as Error).message)
            setDeleting(false)
        }
    }

    useEffect(() => {
        if (!id) return
        if (userLoading) return
        agentsApi
            .list()
            .then((list) => {
                const found = list.find((a) => a.id === id)
                if (!found) setNotFound(true)
                else setAgent(found)
            })
            .catch((e: Error) => setError(e.message))
    }, [agentsApi, id, userLoading])

    useEffect(() => {
        if (!agent || !isAdmin) return
        client.admin.users
            .list()
            .then((rows) => {
                setOwner(rows.find((u) => u.id === agent.userId) ?? null)
            })
            .catch(() => {
                // owner row falls back to agent.userId
            })
    }, [client, agent, isAdmin])

    useEffect(() => {
        if (!agent?.runtimeId) return
        runtimesApi
            .get(agent.runtimeId)
            .then(setRuntime)
            .catch(() => {
                // best-effort — primary-agent detection just becomes false
            })
    }, [runtimesApi, agent])

    const isPrimary =
        !!agent && !!runtime && runtime.primaryAgentId === agent.id

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: t('admin.nav.agents'),
                        to: adminRoutes.agents
                    },
                    {
                        label:
                            agent?.name ?? id ?? t('admin.agents.detail.title')
                    }
                ]}
            />

            {error && (
                <Card
                    elevation='flat'
                    className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-2'
                >
                    <pre className='text-caption-sm text-accent-ruby whitespace-pre-wrap'>
                        {error}
                    </pre>
                </Card>
            )}

            {notFound && (
                <p className='admin-page-description'>
                    {t('admin.agents.detail.notFound')}
                </p>
            )}

            {!agent && !notFound && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {agent && (
                <>
                    <div className='mb-2 flex items-start justify-between gap-2'>
                        <div className='min-w-0 flex-1'>
                            <div className='mb-1 flex items-center gap-2'>
                                <Heading level={2}>{agent.name}</Heading>
                                {isPrimary && (
                                    <Badge tone='brand'>
                                        {t('admin.agents.detail.primaryPill')}
                                    </Badge>
                                )}
                            </div>
                            <p className='text-caption-sm text-body break-all font-mono'>
                                {agent.id}
                            </p>
                            {agent.runtimeId && (
                                <Link
                                    to={adminRoutes.runtime(agent.runtimeId)}
                                    className='text-caption-sm text-brand hover:text-brand-hover mt-2 inline-block'
                                >
                                    {t('admin.agentRuntimes.viewLink')}
                                </Link>
                            )}
                        </div>
                        {isPrimary ? (
                            <Link
                                to={
                                    agent.runtimeId
                                        ? adminRoutes.runtime(agent.runtimeId)
                                        : adminRoutes.runtimes
                                }
                                className='text-caption border-border hover:bg-surface-muted inline-flex h-8 items-center rounded-md border px-3 font-normal'
                            >
                                {t('admin.agents.detail.primaryDeleteButton')}
                            </Link>
                        ) : (
                            <Button
                                variant='neutral'
                                size='sm'
                                onClick={(): void => {
                                    void handleDelete()
                                }}
                                disabled={deleting}
                                className='!text-accent-ruby !border-accent-ruby/30 hover:!bg-accent-ruby/5'
                            >
                                {deleting
                                    ? t('admin.agents.detail.delete.deleting')
                                    : t('admin.agents.detail.delete.button')}
                            </Button>
                        )}
                    </div>

                    {deleteError && (
                        <Card
                            elevation='flat'
                            className='border-accent-ruby/30 bg-accent-ruby/5 mb-2 p-3'
                        >
                            <p className='text-caption-sm text-accent-ruby'>
                                {t('admin.agents.detail.delete.error')}:{' '}
                                {deleteError}
                            </p>
                        </Card>
                    )}

                    <div className='mb-2 flex gap-2'>
                        <Button
                            variant={tab === 'overview' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('overview')}
                        >
                            {t('admin.agents.detail.tabs.overview')}
                        </Button>
                        <Button
                            variant={tab === 'files' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('files')}
                        >
                            {t('admin.agents.detail.tabs.files')}
                        </Button>
                        <Button
                            variant={tab === 'usage' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('usage')}
                        >
                            Usage
                        </Button>
                        <Button
                            variant={tab === 'model' ? 'primary' : 'ghost'}
                            size='sm'
                            onClick={(): void => setTab('model')}
                        >
                            Model
                        </Button>
                    </div>

                    {tab === 'files' && (
                        <Card elevation='ambient'>
                            <CardBody>
                                <Heading level={3} className='mb-3'>
                                    {t('admin.agents.detail.files.title')}
                                </Heading>
                                <FilesTab agent={agent} />
                            </CardBody>
                        </Card>
                    )}

                    {tab === 'usage' && (
                        <UsageTab scope='agent' id={agent.id} />
                    )}

                    {tab === 'model' && (
                        <AgentModelConfigPanel
                            agentId={agent.id}
                            isAdmin={isAdmin}
                        />
                    )}

                    {tab === 'overview' &&
                        agent.status === 'pending' &&
                        (() => {
                            const steps = stepsFor(agent)
                            const phase = agent.currentPhase
                            const currentIndex = isKnownStep(phase, steps)
                                ? steps.indexOf(phase)
                                : 0
                            return (
                                <Card elevation='elevated' className='mb-2'>
                                    <CardBody>
                                        <Heading level={3} className='mb-1'>
                                            {t(
                                                'admin.agents.new.progress.resumedTitle'
                                            )}
                                        </Heading>
                                        <p className='text-caption text-body mb-2'>
                                            {t(
                                                'admin.agents.new.progress.resumedBody'
                                            )}
                                        </p>
                                        <CreateProgress
                                            steps={steps}
                                            currentIndex={currentIndex}
                                            failedStep={null}
                                            errorMessage={null}
                                        />
                                    </CardBody>
                                </Card>
                            )
                        })()}

                    {tab === 'overview' && (
                        <>
                            <Card elevation='ambient'>
                                <Row
                                    label={t('admin.agents.detail.owner')}
                                    value={owner?.email ?? agent.userId}
                                    mono
                                />
                                <Row
                                    label={t('admin.agents.cols.framework')}
                                    value={agent.framework}
                                    mono
                                />
                                {isVersionedFramework(agent.framework) &&
                                agent.runtime === 'sprites' ? (
                                    <Row
                                        label='framework version'
                                        value={
                                            <div className='flex flex-col gap-2'>
                                                <div>
                                                    <span className='font-mono'>
                                                        {agent.frameworkVersion ??
                                                            'not detected'}
                                                    </span>
                                                    {agent.frameworkLatestVersion ? (
                                                        <span
                                                            className={[
                                                                'ml-2',
                                                                agent.frameworkUpgradeAvailable
                                                                    ? 'text-brand'
                                                                    : 'text-body'
                                                            ].join(' ')}
                                                        >
                                                            {agent.frameworkUpgradeAvailable
                                                                ? `↑ latest ${agent.frameworkLatestVersion}`
                                                                : `latest ${agent.frameworkLatestVersion}`}
                                                        </span>
                                                    ) : null}
                                                </div>
                                                {agent.frameworkVersionBlockedReason ? (
                                                    <span className='text-accent-ruby text-caption'>
                                                        {
                                                            agent.frameworkVersionBlockedReason
                                                        }
                                                    </span>
                                                ) : null}
                                                <div className='flex flex-wrap items-center gap-2'>
                                                    <Button
                                                        variant='neutral'
                                                        size='sm'
                                                        disabled={fwRefreshing}
                                                        onClick={(): void => {
                                                            void handleRefreshFrameworkVersion()
                                                        }}
                                                    >
                                                        {fwRefreshing
                                                            ? 'Refreshing…'
                                                            : 'Refresh'}
                                                    </Button>
                                                    {isUpgradeableFramework(
                                                        agent.framework
                                                    ) && !fwPickerOpen ? (
                                                        <Button
                                                            variant='neutral'
                                                            size='sm'
                                                            onClick={(): void => {
                                                                void handleOpenVersionPicker()
                                                            }}
                                                        >
                                                            {agent.frameworkUpgradeAvailable
                                                                ? `Upgrade to ${agent.frameworkLatestVersion}…`
                                                                : 'Change version…'}
                                                        </Button>
                                                    ) : null}
                                                    {fwPickerOpen ? (
                                                        <>
                                                            <select
                                                                className='border-border text-caption rounded-md border px-2 py-1 font-mono'
                                                                value={fwTarget}
                                                                disabled={
                                                                    fwUpgrading ||
                                                                    !fwVersions
                                                                }
                                                                onChange={(
                                                                    event
                                                                ): void =>
                                                                    setFwTarget(
                                                                        event
                                                                            .target
                                                                            .value
                                                                    )
                                                                }
                                                            >
                                                                {fwVersions ? (
                                                                    fwVersions.map(
                                                                        (v) => (
                                                                            <option
                                                                                key={
                                                                                    v
                                                                                }
                                                                                value={
                                                                                    v
                                                                                }
                                                                            >
                                                                                {
                                                                                    v
                                                                                }
                                                                            </option>
                                                                        )
                                                                    )
                                                                ) : (
                                                                    <option value=''>
                                                                        Loading…
                                                                    </option>
                                                                )}
                                                            </select>
                                                            <Button
                                                                variant='primary'
                                                                size='sm'
                                                                disabled={
                                                                    fwUpgrading ||
                                                                    !fwTarget ||
                                                                    fwTarget ===
                                                                        agent.frameworkVersion
                                                                }
                                                                onClick={(): void => {
                                                                    void handleUpgradeFramework()
                                                                }}
                                                            >
                                                                {fwUpgrading
                                                                    ? fwStep
                                                                        ? `Upgrading… ${fwStep.replace(/_/g, ' ')}`
                                                                        : 'Upgrading…'
                                                                    : 'Upgrade'}
                                                            </Button>
                                                            <Button
                                                                variant='neutral'
                                                                size='sm'
                                                                disabled={
                                                                    fwUpgrading
                                                                }
                                                                onClick={(): void =>
                                                                    setFwPickerOpen(
                                                                        false
                                                                    )
                                                                }
                                                            >
                                                                Cancel
                                                            </Button>
                                                        </>
                                                    ) : null}
                                                </div>
                                                {fwError ? (
                                                    <span className='text-accent-ruby text-caption'>
                                                        {fwError}
                                                    </span>
                                                ) : null}
                                            </div>
                                        }
                                    />
                                ) : null}
                                <Row
                                    label='runtime'
                                    value={agent.runtime}
                                    mono
                                />
                                <Row
                                    label={t('admin.agents.cols.status')}
                                    value={
                                        <Badge tone={statusTone[agent.status]}>
                                            {t(
                                                `admin.agents.status.${agent.status}`
                                            )}
                                        </Badge>
                                    }
                                />
                                <Row
                                    label={t('admin.agents.detail.internalId')}
                                    value={agent.internalId}
                                    mono
                                />
                                <Row
                                    label={t('admin.agents.detail.model')}
                                    value={agent.model}
                                    mono
                                />
                                <Row
                                    label='accountSlug'
                                    value={agent.accountSlug}
                                    mono
                                />
                                {agent.runtime === 'k8s' && (
                                    <Row
                                        label={t('admin.agents.cols.cluster')}
                                        value={
                                            agent.clusterName &&
                                            agent.clusterId ? (
                                                <Link
                                                    to={adminRoutes.cluster(
                                                        agent.clusterId
                                                    )}
                                                    className='text-brand hover:text-brand-hover font-mono'
                                                >
                                                    {agent.clusterName}
                                                </Link>
                                            ) : agent.clusterName ? (
                                                <span className='font-mono'>
                                                    {agent.clusterName}
                                                </span>
                                            ) : agent.clusterId ? (
                                                <span className='text-accent-ruby font-mono'>
                                                    {agent.clusterId} (deleted)
                                                </span>
                                            ) : null
                                        }
                                    />
                                )}
                                <Row
                                    label='Stateful sandbox name'
                                    value={agent.spriteName}
                                    mono
                                />
                                <Row
                                    label='Stateful sandbox ID'
                                    value={agent.spriteId}
                                    mono
                                />
                                <Row
                                    label='mountPath'
                                    value={agent.mountPath}
                                    mono
                                />
                                {agent.failureReason && (
                                    <Row
                                        label='failureReason'
                                        value={
                                            <span className='text-accent-ruby'>
                                                {agent.failureReason}
                                            </span>
                                        }
                                    />
                                )}
                                <Row
                                    label='startedAt'
                                    value={
                                        <span className='tnum'>
                                            {formatDate(agent.startedAt)}
                                        </span>
                                    }
                                />
                                <Row
                                    label='lastBootstrappedAt'
                                    value={
                                        <span className='tnum'>
                                            {formatDate(
                                                agent.lastBootstrappedAt
                                            )}
                                        </span>
                                    }
                                />
                                <Row
                                    label={t(
                                        'admin.agents.detail.lastReconciledAt'
                                    )}
                                    value={
                                        <span className='tnum'>
                                            {formatDate(agent.lastReconciledAt)}
                                        </span>
                                    }
                                />
                                <Row
                                    label={t('admin.agents.cols.createdAt')}
                                    value={
                                        <span className='tnum'>
                                            {formatDate(agent.createdAt)}
                                        </span>
                                    }
                                />
                                <Row
                                    label='updatedAt'
                                    value={
                                        <span className='tnum'>
                                            {formatDate(agent.updatedAt)}
                                        </span>
                                    }
                                />
                            </Card>

                            <Card elevation='ambient' className='mt-2'>
                                <CardBody>
                                    <div className='mb-2 flex items-center justify-between gap-2'>
                                        <Heading level={3}>
                                            {t(
                                                'admin.agents.detail.frameworkInternals.title'
                                            )}
                                        </Heading>
                                        <Button
                                            variant='ghost'
                                            size='sm'
                                            onClick={(): void =>
                                                setInternalsOpen((v) => !v)
                                            }
                                        >
                                            {internalsOpen
                                                ? t(
                                                      'admin.agents.detail.frameworkInternals.collapse'
                                                  )
                                                : t(
                                                      'admin.agents.detail.frameworkInternals.expand'
                                                  )}
                                        </Button>
                                    </div>
                                    {internalsOpen &&
                                        (Object.keys(agent.extras ?? {})
                                            .length === 0 ? (
                                            <p className='text-caption text-body'>
                                                {t(
                                                    'admin.agents.detail.frameworkInternals.empty'
                                                )}
                                            </p>
                                        ) : (
                                            <pre className='bg-surface-subtle text-caption-sm overflow-x-auto rounded p-3 font-mono'>
                                                {JSON.stringify(
                                                    agent.extras,
                                                    null,
                                                    2
                                                )}
                                            </pre>
                                        ))}
                                </CardBody>
                            </Card>

                            {isAdmin && <AgentSessionsCard agentId={agent.id} />}
                        </>
                    )}
                </>
            )}
        </DetailPage>
    )
}

export default AgentDetail
