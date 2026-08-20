import type {
    DaemonHostSummary,
    DaemonStartupMethod,
    DaemonTokenSummary
} from '@manyfold/shared'
import type { FC, FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    DaemonConnectCommands,
    DaemonFrameworkTags,
    DaemonStatusDot
} from '@/components/DaemonShared'
import { GhostSettingsRows } from '@/components/Loading'
import { useLoadingGate } from '@/components/useLoadingGate'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorDetailMessage, apiErrorMessage } from '@/lib/errorMessage'
import { docsHref } from '@/lib/docsLinks'
import { useI18n, type TFn } from '@/lib/i18n'
import { formatLocalDateTime } from '@/lib/usageFormat'

const formatStartupMethod = (m: DaemonStartupMethod | null, t: TFn): string => {
    if (!m) return t('web.selfOwned.startupUnknown')
    const keys: Record<DaemonStartupMethod, Parameters<TFn>[0]> = {
        'launchd-user': 'web.selfOwned.startupLaunchdUser',
        'launchd-system': 'web.selfOwned.startupLaunchdSystem',
        'systemd-user': 'web.selfOwned.startupSystemdUser',
        'systemd-system': 'web.selfOwned.startupSystemdSystem',
        manual: 'web.selfOwned.startupManual'
    }
    return t(keys[m])
}

const LocalDaemons: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [hosts, setHosts] = useState<DaemonHostSummary[]>([])
    const [tokens, setTokens] = useState<DaemonTokenSummary[]>([])
    const [tokenName, setTokenName] = useState('')
    const [issuedToken, setIssuedToken] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    // §10.8: this page polls every 5s, so only the cold load may ghost —
    // each poll must leave the visible rows alone.
    const [loading, setLoading] = useState(true)
    const gate = useLoadingGate(loading)

    const refresh = async (): Promise<void> => {
        try {
            const [hostRows, tokenRows] = await Promise.all([
                client.daemons.listHosts(),
                client.daemons.listTokens()
            ])
            setHosts(hostRows)
            setTokens(tokenRows)
            setError(null)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        void refresh()
        const t = setInterval(() => void refresh(), 5_000)
        return () => clearInterval(t)
    }, [client])

    const issueToken = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
        e.preventDefault()
        if (!tokenName.trim()) return
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            const res = await client.daemons.issueToken({
                name: tokenName.trim()
            })
            setIssuedToken(res.token)
            setTokenName('')
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const revokeToken = async (id: string): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.selfOwned.revokeTokenTitle'),
                description: t('web.selfOwned.revokeTokenDesc'),
                confirmLabel: t('web.selfOwned.revoke'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        try {
            await client.daemons.revokeToken(id)
            setMessage(t('web.selfOwned.msgTokenRevoked'))
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const revokeHost = async (id: string): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.selfOwned.revokeHostTitle'),
                description: t('web.selfOwned.revokeHostDesc'),
                confirmLabel: t('web.selfOwned.revoke'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        try {
            await client.daemons.revokeHost(id)
            setMessage(t('web.selfOwned.msgMachineRevoked'))
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const deleteHost = async (host: DaemonHostSummary): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.selfOwned.deleteHostTitle'),
                description: t('web.selfOwned.deleteHostDesc', {
                    name: host.name
                }),
                confirmLabel: t('web.selfOwned.delete'),
                tone: 'danger',
                requireMatch: host.name
            }))
        ) {
            return
        }
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            await client.daemons.deleteHost(host.id)
            setMessage(t('web.selfOwned.msgMachineDeleted'))
            await refresh()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const upgradeHost = async (h: DaemonHostSummary): Promise<void> => {
        if (
            !(await confirm({
                title: t('web.selfOwned.upgradeHostTitle'),
                description: t('web.selfOwned.upgradeHostDesc', {
                    version: h.latestCliVersion ?? 'latest',
                    name: h.name
                }),
                confirmLabel: t('web.selfOwned.upgradeHostConfirm'),
                tone: 'danger'
            }))
        ) {
            return
        }
        setBusy(true)
        setError(null)
        setMessage(null)
        try {
            const res = await client.daemons.upgradeHost(h.id)
            setMessage(
                res.restarting
                    ? t('web.selfOwned.msgUpgrading', {
                          name: h.name,
                          version: res.toVersion ?? 'latest'
                      })
                    : t('web.selfOwned.msgUpToDate', {
                          name: h.name,
                          version: res.toVersion ?? 'latest'
                      })
            )
            await refresh()
        } catch (err) {
            setError(apiErrorDetailMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const steps = [
        t('web.connectDaemon.step1'),
        t('web.connectDaemon.step2'),
        t('web.connectDaemon.step3')
    ]

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                breadcrumb={[
                    {
                        label: t('web.selfOwned.breadcrumbRuntimes'),
                        to: '/settings/runtimes'
                    },
                    { label: t('web.selfOwned.title') }
                ]}
                title={t('web.selfOwned.title')}
            />
            {message && <div className='workbench-note mb-4'>{message}</div>}
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            <section className='settings-section'>
                <h2 className='settings-section-label'>
                    {t('web.selfOwned.connectedTitle')}
                </h2>
                <div className='settings-card' aria-busy={gate.showLoading}>
                    {gate.showLoading ? (
                        <GhostSettingsRows rows={2} />
                    ) : loading ? null : hosts.length === 0 ? (
                        <div className='settings-card-row'>
                            <p className='settings-card-copy'>
                                {t('web.selfOwned.connectedEmpty')}
                            </p>
                        </div>
                    ) : (
                        hosts.map((h) => (
                            <div key={h.id} className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label flex items-center gap-2'>
                                        <DaemonStatusDot online={h.online} />
                                        <span>{h.name}</span>
                                        <span className='text-caption text-muted'>
                                            {h.os ?? '?'}/{h.arch ?? '?'}
                                        </span>
                                    </div>
                                    <div className='settings-card-copy'>
                                        {t('web.selfOwned.machineMeta', {
                                            frameworks: h.runtimes.length,
                                            agents: h.agentCount,
                                            lastSeen: h.lastSeenAt
                                                ? formatLocalDateTime(
                                                      h.lastSeenAt
                                                  )
                                                : '—'
                                        })}
                                        {h.online && (
                                            <>
                                                {' · '}
                                                <Link
                                                    to={`/agents/new?daemonId=${h.id}`}
                                                    className='text-link hover:underline'
                                                >
                                                    {t(
                                                        'web.selfOwned.createAgent'
                                                    )}
                                                </Link>
                                            </>
                                        )}
                                    </div>
                                    <div className='settings-card-copy text-caption text-muted'>
                                        <span className='font-mono'>
                                            {t('web.selfOwned.cliVersion', {
                                                version:
                                                    h.cliVersion ??
                                                    t('common.unknown')
                                            })}
                                        </span>
                                        {h.updateAvailable &&
                                            h.latestCliVersion &&
                                            (h.canRemoteUpgrade ? (
                                                <ShortcutTooltip
                                                    label={t(
                                                        'web.selfOwned.upgradeAvailableTip'
                                                    )}
                                                >
                                                    <button
                                                        type='button'
                                                        disabled={busy}
                                                        onClick={() =>
                                                            upgradeHost(h)
                                                        }
                                                        className='text-link ml-1 font-mono hover:underline disabled:opacity-50'
                                                    >
                                                        ↑ {h.latestCliVersion}
                                                    </button>
                                                </ShortcutTooltip>
                                            ) : (
                                                <ShortcutTooltip
                                                    label={t(
                                                        'web.selfOwned.upgradeBlockedTip'
                                                    )}
                                                >
                                                    <span className='ml-1 font-mono'>
                                                        →{' '}
                                                        {t(
                                                            'web.selfOwned.upgradeAvailableSuffix',
                                                            {
                                                                version:
                                                                    h.latestCliVersion
                                                            }
                                                        )}
                                                    </span>
                                                </ShortcutTooltip>
                                            ))}
                                        {' · '}
                                        {formatStartupMethod(
                                            h.startupMethod,
                                            t
                                        )}
                                    </div>
                                    <div className='settings-card-copy text-caption text-muted'>
                                        <DaemonFrameworkTags host={h} />
                                    </div>
                                    {h.needsUpgrade && (
                                        <div className='bg-danger-bg text-fg shadow-ring-light mt-2 rounded-md px-3 py-2'>
                                            <div className='text-caption font-medium'>
                                                {t(
                                                    'web.selfOwned.needsUpgradeTitle'
                                                )}
                                            </div>
                                            <div className='text-caption mt-0.5'>
                                                {t(
                                                    'web.selfOwned.needsUpgradeHintPrefix'
                                                )}{' '}
                                                <code className='font-mono'>
                                                    mf update
                                                </code>{' '}
                                                {t(
                                                    'web.selfOwned.needsUpgradeHintThen'
                                                )}{' '}
                                                <code className='font-mono'>
                                                    mf daemon stop && mf daemon
                                                    start
                                                </code>
                                                .{' '}
                                                <a
                                                    href={docsHref(
                                                        '/docs/local-daemons'
                                                    )}
                                                    target='_blank'
                                                    rel='noreferrer'
                                                    className='text-link hover:underline'
                                                >
                                                    {t(
                                                        'web.connectDaemon.learnHow'
                                                    )}{' '}
                                                    →
                                                </a>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className='settings-card-side'>
                                    {h.status === 'revoked' ? (
                                        <button
                                            type='button'
                                            disabled={busy}
                                            onClick={() => deleteHost(h)}
                                            className='workbench-button-danger text-caption h-8 px-3'
                                        >
                                            {t('web.selfOwned.delete')}
                                        </button>
                                    ) : (
                                        <button
                                            type='button'
                                            disabled={busy}
                                            onClick={() => revokeHost(h.id)}
                                            className='workbench-button-secondary text-caption h-8 px-3'
                                        >
                                            {t('web.selfOwned.revoke')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </section>

            <section className='settings-section'>
                <div className='settings-card p-5'>
                    <div className='settings-card-label'>
                        {t('web.selfOwned.connectNewTitle')}
                    </div>
                    <ol className='mt-3 flex flex-col gap-2.5'>
                        {steps.map((label, i) => (
                            <li key={label} className='flex items-start gap-3'>
                                <span className='bg-info-bg text-link text-caption flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-medium'>
                                    {i + 1}
                                </span>
                                <span className='text-fg text-ui'>{label}</span>
                            </li>
                        ))}
                    </ol>
                    <form
                        onSubmit={issueToken}
                        className='mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row'
                    >
                        <input
                            value={tokenName}
                            onChange={(e) => setTokenName(e.target.value)}
                            placeholder={t('web.connectDaemon.namePlaceholder')}
                            className='workbench-input'
                        />
                        <button
                            type='submit'
                            disabled={busy || !tokenName.trim()}
                            className='workbench-button-primary h-11 sm:w-40'
                        >
                            {t('web.selfOwned.issue')}
                        </button>
                    </form>
                    {issuedToken && (
                        <div className='mt-4'>
                            <DaemonConnectCommands
                                token={issuedToken}
                                onCopy={() =>
                                    setMessage(
                                        t('web.selfOwned.msgCommandCopied')
                                    )
                                }
                            />
                        </div>
                    )}
                </div>
            </section>

            <section className='settings-section'>
                <h2 className='settings-section-label'>
                    {t('web.selfOwned.tokensTitle')}
                </h2>
                <div className='settings-card' aria-busy={gate.showLoading}>
                    {gate.showLoading ? (
                        <GhostSettingsRows rows={2} />
                    ) : loading ? null : tokens.length === 0 ? (
                        <div className='settings-card-row'>
                            <p className='settings-card-copy'>
                                {t('web.selfOwned.tokensEmpty')}
                            </p>
                        </div>
                    ) : (
                        tokens.map((tk) => (
                            <div key={tk.id} className='settings-card-row'>
                                <div className='min-w-0'>
                                    <div className='settings-card-label'>
                                        {tk.name}
                                    </div>
                                    <div className='settings-card-copy text-caption text-muted'>
                                        {t('web.selfOwned.tokenMeta', {
                                            bound:
                                                tk.daemonId ??
                                                t('web.selfOwned.boundUnbound'),
                                            lastUsed: tk.lastUsedAt
                                                ? formatLocalDateTime(
                                                      tk.lastUsedAt
                                                  )
                                                : '—'
                                        })}
                                        {tk.revokedAt
                                            ? t(
                                                  'web.selfOwned.tokenRevokedMeta',
                                                  {
                                                      revoked:
                                                          formatLocalDateTime(
                                                              tk.revokedAt
                                                          )
                                                  }
                                              )
                                            : ''}
                                    </div>
                                </div>
                                <div className='settings-card-side'>
                                    {!tk.revokedAt && (
                                        <button
                                            type='button'
                                            disabled={busy}
                                            onClick={() => revokeToken(tk.id)}
                                            className='workbench-button-secondary text-caption h-8 px-3'
                                        >
                                            {t('web.selfOwned.revoke')}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </section>
            {confirmDialog}
        </div>
    )
}

export default LocalDaemons
