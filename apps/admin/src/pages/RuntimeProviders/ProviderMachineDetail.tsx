import type {
    ProviderMachineAction,
    ProviderMachineSummary,
    ProviderMachineUpgradeResult,
    RuntimeProviderSummary
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getLocale, t } from '@manyfold/i18n'
import { ApiError } from '@manyfold/sdk'
import { useApiClient } from '@/lib/apiClient'
import { lifecycleTone, powerLabel } from '@/lib/hostStatus'
import {
    machineActionDetail,
    machineActionLabel,
    machineActions,
    machineErrorMessage,
    machinePowerTone,
    ranRecently,
    stepLabel
} from '@/lib/providerInventory'
import { useShellPolling } from '@/lib/useShellPolling'
import { adminRoutes } from '@/routes'
import {
    Badge,
    Breadcrumbs,
    Button,
    Card,
    ConfirmDialog,
    DetailPage,
    Heading,
    Input
} from '@/ui'

// A machine's power changes on its own (it sleeps when idle, it reboots on a
// restart); the provider read behind this page never wakes it.
const POLL_MS = 15_000

type DialogKind = 'restart' | 'upgrade' | 'delete'

interface UpgradeProgress {
    from: string | null
    steps: string[]
    result: ProviderMachineUpgradeResult | null
    error: string | null
}

const when = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleString(getLocale()) : '—'

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

const SectionCard: FC<{ title: string; children: ReactNode }> = ({
    title,
    children
}): ReactNode => (
    <Card elevation='ambient' className='overflow-hidden'>
        <div className='border-border border-b px-2 py-1.5'>
            <Heading level={3}>{title}</Heading>
        </div>
        {children}
    </Card>
)

const upgradeOutcome = (result: ProviderMachineUpgradeResult): string => {
    switch (result.outcome) {
        case 'completed':
            return t('admin.runtimeProviders.machine.upgrade.completed', {
                from: result.fromVersion ?? '—',
                to: result.targetVersion ?? '—'
            })
        case 'skipped':
            return t('admin.runtimeProviders.machine.upgrade.skipped', {
                message: result.message ?? ''
            })
        case 'failed':
            return t('admin.runtimeProviders.machine.upgrade.failed', {
                message: result.message ?? ''
            })
        default:
            return t('admin.runtimeProviders.machine.upgrade.unconfirmed', {
                step: stepLabel(result.lastStep ?? '')
            })
    }
}

const ProviderMachineDetail: FC = (): ReactNode => {
    const { id = '', name = '' } = useParams<{ id: string; name: string }>()
    const client = useApiClient()
    const navigate = useNavigate()
    const [provider, setProvider] = useState<RuntimeProviderSummary | null>(
        null
    )
    const [machine, setMachine] = useState<ProviderMachineSummary | null>(null)
    const [missing, setMissing] = useState(false)
    const [actions, setActions] = useState<ProviderMachineAction[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [dialog, setDialog] = useState<DialogKind | null>(null)
    const [busy, setBusy] = useState(false)
    const [dialogError, setDialogError] = useState<string | null>(null)
    const [targetVersion, setTargetVersion] = useState('')
    const [allowStorageMigration, setAllowStorageMigration] = useState(false)
    const [upgrade, setUpgrade] = useState<UpgradeProgress | null>(null)

    useEffect(() => {
        client.admin.runtimeProviders
            .get(id)
            .then(setProvider)
            .catch((e: unknown) => setError(machineErrorMessage(e)))
    }, [client, id])

    const loadMachine = useCallback(
        (): Promise<void> =>
            client.admin.runtimeProviders.machines
                .get(id, name)
                .then((next) => {
                    setMachine(next)
                    setMissing(false)
                })
                .catch((e: unknown) => {
                    if (e instanceof ApiError && e.status === 404)
                        setMissing(true)
                    else setError(machineErrorMessage(e))
                }),
        [client, id, name]
    )
    const refreshMachine = useShellPolling(loadMachine, POLL_MS)

    const loadActions = useCallback(
        (): Promise<void> =>
            client.admin.runtimeProviders.machines
                .actions(id, name)
                .then(setActions)
                .catch((e: unknown) => setError(machineErrorMessage(e))),
        [client, id, name]
    )
    useEffect(() => {
        void loadActions()
    }, [loadActions])

    const open = (kind: DialogKind): void => {
        setDialog(kind)
        setDialogError(null)
        setTargetVersion('')
        setAllowStorageMigration(false)
    }

    const afterAction = (): void => {
        refreshMachine()
        void loadActions()
    }

    const restart = async (): Promise<void> => {
        setBusy(true)
        setDialogError(null)
        try {
            const result = await client.admin.runtimeProviders.machines.restart(
                id,
                name
            )
            setDialog(null)
            setNotice(
                t('admin.runtimeProviders.machine.restart.done', {
                    message: result.message ?? ''
                })
            )
            afterAction()
        } catch (e) {
            setDialogError(machineErrorMessage(e))
        } finally {
            setBusy(false)
        }
    }

    const runUpgrade = async (): Promise<void> => {
        setBusy(true)
        setDialogError(null)
        setNotice(null)
        let accepted = false
        try {
            const version = targetVersion.trim()
            const result = await client.admin.runtimeProviders.machines.upgrade(
                id,
                name,
                {
                    ...(version ? { version } : {}),
                    ...(allowStorageMigration ? { allowStorageMigration } : {})
                },
                (event) => {
                    if (event.type === 'accepted') {
                        // The provider has it now; the page shows the rest.
                        accepted = true
                        setDialog(null)
                        setBusy(false)
                        setUpgrade({
                            from: event.fromVersion,
                            steps: [],
                            result: null,
                            error: null
                        })
                    }
                    // A provider can repeat a step (sprites.dev sends `started` twice).
                    if (event.type === 'step')
                        setUpgrade((current) =>
                            current && current.steps.at(-1) !== event.step
                                ? {
                                      ...current,
                                      steps: [...current.steps, event.step]
                                  }
                                : current
                        )
                }
            )
            setUpgrade((current) => ({
                from: current?.from ?? result.fromVersion,
                steps: current?.steps ?? [],
                result,
                error: null
            }))
        } catch (e) {
            if (accepted)
                setUpgrade((current) =>
                    current
                        ? { ...current, error: machineErrorMessage(e) }
                        : current
                )
            else setDialogError(machineErrorMessage(e))
        } finally {
            setBusy(false)
            afterAction()
        }
    }

    const remove = async (): Promise<void> => {
        setBusy(true)
        setDialogError(null)
        try {
            await client.admin.runtimeProviders.machines.delete(id, name)
            setDialog(null)
            navigate(adminRoutes.runtimeProviderInventory(id))
        } catch (e) {
            setDialogError(machineErrorMessage(e))
        } finally {
            setBusy(false)
        }
    }

    const allowed =
        machine && provider
            ? machineActions(machine, provider.capabilities)
            : null
    const host = machine?.host ?? null
    const elsewhere =
        machine && !host && ranRecently(machine)
            ? t('admin.runtimeProviders.machine.recentlyRan')
            : null
    const whose = host
        ? t('admin.runtimeProviders.machine.tracked', {
              sandbox: host.name,
              owner: host.ownerEmail ?? host.userId
          })
        : t('admin.runtimeProviders.machine.untrackedShort')
    const latestStep = upgrade?.steps.at(-1)
    const upgrading =
        upgrade !== null && upgrade.result === null && upgrade.error === null

    return (
        <DetailPage>
            <Breadcrumbs
                items={[
                    {
                        label: t('admin.nav.runtimeProviders'),
                        to: adminRoutes.runtimeProviders
                    },
                    {
                        label: provider?.name ?? id,
                        to: adminRoutes.runtimeProvider(id)
                    },
                    {
                        label: t('admin.runtimeProviders.tabs.inventory'),
                        to: adminRoutes.runtimeProviderInventory(id)
                    },
                    { label: name }
                ]}
            />
            <div className='mb-3 flex flex-wrap items-start justify-between gap-2'>
                <div>
                    <Heading level={2} className='mb-1 font-mono'>
                        {name}
                    </Heading>
                    {machine && (
                        <div className='flex flex-wrap items-center gap-1'>
                            <Badge tone={machinePowerTone(machine.power)}>
                                <span title={machine.status}>
                                    {powerLabel(machine.power)}
                                </span>
                            </Badge>
                            <Badge tone={host ? 'brand' : 'neutral'}>
                                {host
                                    ? t(
                                          'admin.runtimeProviders.inventory.tracked'
                                      )
                                    : t(
                                          'admin.runtimeProviders.inventory.untracked'
                                      )}
                            </Badge>
                        </div>
                    )}
                </div>
                {allowed && (
                    <div className='flex flex-wrap gap-2'>
                        {provider?.capabilities.restartMachine && (
                            <Button
                                variant='ghost'
                                disabled={!allowed.restart || busy}
                                title={
                                    allowed.hostBusy
                                        ? t(
                                              'admin.runtimeProviders.machine.errors.hostBusy'
                                          )
                                        : undefined
                                }
                                onClick={(): void => open('restart')}
                            >
                                {t(
                                    'admin.runtimeProviders.machine.actions.restart'
                                )}
                            </Button>
                        )}
                        {provider?.capabilities.upgradeMachine && (
                            <Button
                                variant='ghost'
                                disabled={!allowed.upgrade || busy || upgrading}
                                title={
                                    allowed.hostBusy
                                        ? t(
                                              'admin.runtimeProviders.machine.errors.hostBusy'
                                          )
                                        : undefined
                                }
                                onClick={(): void => open('upgrade')}
                            >
                                {t(
                                    'admin.runtimeProviders.machine.actions.upgrade'
                                )}
                            </Button>
                        )}
                        <Button
                            variant='neutral'
                            disabled={!allowed.delete || busy}
                            title={
                                allowed.agents > 0
                                    ? t(
                                          'admin.runtimeProviders.machine.delete.blocked',
                                          {
                                              count: allowed.agents
                                          }
                                      )
                                    : undefined
                            }
                            className='!text-accent-ruby !border-accent-ruby/30 hover:!bg-accent-ruby/5'
                            onClick={(): void => open('delete')}
                        >
                            {t('admin.runtimeProviders.machine.actions.delete')}
                        </Button>
                    </div>
                )}
            </div>

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
            {notice && (
                <Card
                    elevation='flat'
                    className='border-success-ring bg-success-bg mb-2 p-2'
                >
                    <p className='text-caption-sm text-success-text'>
                        {notice}
                    </p>
                </Card>
            )}
            {upgrade && (
                <Card elevation='flat' className='border-border mb-2 p-2'>
                    <div
                        aria-live='polite'
                        className='text-caption-sm text-body'
                    >
                        {upgrade.result ? (
                            <p
                                className={
                                    upgrade.result.outcome === 'failed'
                                        ? 'text-accent-ruby'
                                        : 'text-heading'
                                }
                            >
                                {upgradeOutcome(upgrade.result)}
                            </p>
                        ) : upgrade.error ? (
                            <p className='text-accent-ruby'>{upgrade.error}</p>
                        ) : (
                            <p>
                                {t(
                                    'admin.runtimeProviders.machine.upgrade.running',
                                    {
                                        step: stepLabel(latestStep ?? 'started')
                                    }
                                )}
                            </p>
                        )}
                    </div>
                    {upgrade.steps.length > 0 && (
                        <p className='text-caption-sm text-body mt-1 font-mono'>
                            {upgrade.steps.map(stepLabel).join(' → ')}
                        </p>
                    )}
                </Card>
            )}

            {missing && (
                <p className='text-caption text-body'>
                    {t('admin.runtimeProviders.machine.notFound', { name })}
                </p>
            )}
            {!machine && !missing && !error && (
                <p className='text-caption text-body'>{t('common.loading')}</p>
            )}

            {machine && (
                <div className='space-y-2'>
                    <div className='grid gap-2 lg:grid-cols-2'>
                        <SectionCard
                            title={t('admin.runtimeProviders.machine.overview')}
                        >
                            <dl>
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.status'
                                    )}
                                    value={`${powerLabel(machine.power)} (${machine.status})`}
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.id'
                                    )}
                                    value={machine.id}
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.version'
                                    )}
                                    value={machine.version}
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.environmentVersion'
                                    )}
                                    value={machine.environmentVersion}
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.labels'
                                    )}
                                    value={
                                        machine.labels.length > 0
                                            ? machine.labels.join(', ')
                                            : null
                                    }
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.url'
                                    )}
                                    value={
                                        machine.url && (
                                            <a
                                                href={machine.url}
                                                target='_blank'
                                                rel='noreferrer'
                                                className='text-brand hover:text-brand-hover'
                                            >
                                                {machine.url}
                                            </a>
                                        )
                                    }
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.urlAccess'
                                    )}
                                    value={
                                        machine.urlAuth
                                            ? [
                                                  machine.urlAuth,
                                                  machine.urlPrivateAccess
                                              ]
                                                  .filter(Boolean)
                                                  .join(' · ')
                                            : null
                                    }
                                    mono
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.created'
                                    )}
                                    value={when(machine.createdAt)}
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.updated'
                                    )}
                                    value={when(machine.updatedAt)}
                                />
                                <Row
                                    label={t(
                                        'admin.runtimeProviders.machine.fields.lastRunning'
                                    )}
                                    value={when(machine.lastRunningAt)}
                                />
                            </dl>
                        </SectionCard>

                        <SectionCard
                            title={t(
                                'admin.runtimeProviders.machine.inDeployment'
                            )}
                        >
                            {host ? (
                                <dl>
                                    <Row
                                        label={t(
                                            'admin.runtimeProviders.machine.fields.sandbox'
                                        )}
                                        value={host.name}
                                    />
                                    <Row
                                        label={t(
                                            'admin.runtimeProviders.machine.fields.owner'
                                        )}
                                        value={
                                            <Link
                                                to={adminRoutes.accountUser(
                                                    host.userId
                                                )}
                                                className='text-brand hover:text-brand-hover'
                                            >
                                                {host.ownerEmail ?? host.userId}
                                            </Link>
                                        }
                                    />
                                    <Row
                                        label={t(
                                            'admin.runtimeProviders.machine.fields.hostStatus'
                                        )}
                                        value={
                                            <Badge
                                                tone={lifecycleTone(
                                                    host.status
                                                )}
                                            >
                                                {t(
                                                    `admin.hostStatus.lifecycle.${host.status}`
                                                )}
                                            </Badge>
                                        }
                                    />
                                    <Row
                                        label={t(
                                            'admin.runtimeProviders.machine.fields.agents'
                                        )}
                                        value={
                                            <span className='tnum'>
                                                {host.agentsCount}
                                            </span>
                                        }
                                    />
                                    {host.providerId !== id && (
                                        <Row
                                            label={t(
                                                'admin.runtimeProviders.machine.fields.provider'
                                            )}
                                            value={
                                                <Link
                                                    to={adminRoutes.runtimeProvider(
                                                        host.providerId
                                                    )}
                                                    className='text-brand hover:text-brand-hover'
                                                >
                                                    {host.providerName}
                                                </Link>
                                            }
                                        />
                                    )}
                                </dl>
                            ) : (
                                <div className='text-caption text-body space-y-1 px-2 py-1.5'>
                                    <p>
                                        {t(
                                            'admin.runtimeProviders.machine.untrackedExplain'
                                        )}
                                    </p>
                                    {elsewhere && (
                                        <p className='text-accent-lemon'>
                                            {elsewhere}
                                        </p>
                                    )}
                                </div>
                            )}
                        </SectionCard>
                    </div>

                    <SectionCard
                        title={t(
                            'admin.runtimeProviders.machine.history.title'
                        )}
                    >
                        {actions === null ? (
                            <p className='text-caption text-body px-2 py-1.5'>
                                {t('common.loading')}
                            </p>
                        ) : actions.length === 0 ? (
                            <p className='text-caption text-body px-2 py-1.5'>
                                {t(
                                    'admin.runtimeProviders.machine.history.empty'
                                )}
                            </p>
                        ) : (
                            <div className='overflow-x-auto'>
                                <table className='admin-table w-full min-w-[640px] text-left'>
                                    <thead className='border-border bg-surface-subtle text-caption-sm text-body border-b'>
                                        <tr>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t(
                                                    'admin.runtimeProviders.machine.history.when'
                                                )}
                                            </th>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t(
                                                    'admin.runtimeProviders.machine.history.action'
                                                )}
                                            </th>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t(
                                                    'admin.runtimeProviders.machine.history.by'
                                                )}
                                            </th>
                                            <th className='px-2 py-1.5 font-normal'>
                                                {t(
                                                    'admin.runtimeProviders.machine.history.detail'
                                                )}
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className='divide-border divide-y'>
                                        {actions.map((action) => (
                                            <tr
                                                key={action.id}
                                                className='text-caption text-heading'
                                            >
                                                <td className='tnum whitespace-nowrap px-2 py-1.5'>
                                                    {when(action.createdAt)}
                                                </td>
                                                <td className='px-2 py-1.5'>
                                                    {machineActionLabel(
                                                        action.action
                                                    )}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {action.actorEmail ?? '—'}
                                                </td>
                                                <td className='px-2 py-1.5 font-mono'>
                                                    {machineActionDetail(
                                                        action.meta
                                                    ) || '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </SectionCard>
                </div>
            )}

            <ConfirmDialog
                open={dialog === 'restart'}
                title={t('admin.runtimeProviders.machine.restart.title', {
                    name
                })}
                requireMatch={name}
                confirmLabel={t(
                    'admin.runtimeProviders.machine.restart.confirm'
                )}
                pendingLabel={t(
                    'admin.runtimeProviders.machine.restart.pending'
                )}
                pending={busy}
                error={dialogError}
                onConfirm={(): void => {
                    void restart()
                }}
                onCancel={(): void => setDialog(null)}
            >
                <p>{t('admin.runtimeProviders.machine.restart.body')}</p>
                <p>{whose}</p>
                {host && (
                    <p>{t('admin.runtimeProviders.machine.disruptsSandbox')}</p>
                )}
                {elsewhere && <p className='text-accent-lemon'>{elsewhere}</p>}
            </ConfirmDialog>

            <ConfirmDialog
                open={dialog === 'upgrade'}
                title={t('admin.runtimeProviders.machine.upgrade.title', {
                    name
                })}
                requireMatch={name}
                confirmLabel={t(
                    'admin.runtimeProviders.machine.upgrade.confirm'
                )}
                pendingLabel={t(
                    'admin.runtimeProviders.machine.upgrade.pending'
                )}
                pending={busy}
                error={dialogError}
                onConfirm={(): void => {
                    void runUpgrade()
                }}
                onCancel={(): void => setDialog(null)}
            >
                <p>{t('admin.runtimeProviders.machine.upgrade.body')}</p>
                {machine?.version ? (
                    <p>
                        {t('admin.runtimeProviders.machine.upgrade.current', {
                            version: machine.version
                        })}
                    </p>
                ) : (
                    <p className='text-accent-lemon'>
                        {t(
                            'admin.runtimeProviders.machine.upgrade.versionUnknown'
                        )}
                    </p>
                )}
                <p>{whose}</p>
                {host && (
                    <p>{t('admin.runtimeProviders.machine.disruptsSandbox')}</p>
                )}
                {elsewhere && <p className='text-accent-lemon'>{elsewhere}</p>}
                <Input
                    id='machine-upgrade-version'
                    label={t(
                        'admin.runtimeProviders.machine.upgrade.versionLabel'
                    )}
                    hint={t(
                        'admin.runtimeProviders.machine.upgrade.versionHint'
                    )}
                    value={targetVersion}
                    onChange={(event): void =>
                        setTargetVersion(event.target.value)
                    }
                    className='font-mono'
                    spellCheck={false}
                    autoComplete='off'
                />
                <label className='text-caption text-heading flex items-start gap-2'>
                    <input
                        type='checkbox'
                        className='mt-0.5'
                        checked={allowStorageMigration}
                        onChange={(event): void =>
                            setAllowStorageMigration(event.target.checked)
                        }
                    />
                    <span>
                        {t(
                            'admin.runtimeProviders.machine.upgrade.storageLabel'
                        )}
                        <span className='text-caption-sm text-body mt-0.5 block'>
                            {t(
                                'admin.runtimeProviders.machine.upgrade.storageWarning'
                            )}
                        </span>
                    </span>
                </label>
            </ConfirmDialog>

            <ConfirmDialog
                open={dialog === 'delete'}
                title={t('admin.runtimeProviders.machine.delete.title', {
                    name
                })}
                requireMatch={name}
                confirmLabel={t(
                    'admin.runtimeProviders.machine.delete.confirm'
                )}
                pendingLabel={t(
                    'admin.runtimeProviders.machine.delete.pending'
                )}
                tone='danger'
                pending={busy}
                error={dialogError}
                onConfirm={(): void => {
                    void remove()
                }}
                onCancel={(): void => setDialog(null)}
            >
                <p>
                    {host
                        ? t(
                              'admin.runtimeProviders.machine.delete.bodyTracked',
                              {
                                  sandbox: host.name,
                                  owner: host.ownerEmail ?? host.userId
                              }
                          )
                        : t(
                              'admin.runtimeProviders.machine.delete.bodyUntracked'
                          )}
                </p>
                {elsewhere && <p className='text-accent-lemon'>{elsewhere}</p>}
            </ConfirmDialog>
        </DetailPage>
    )
}

export default ProviderMachineDetail
