import type { AgentFramework, PodHostSummary } from '@manyfold/shared'
import {
    frameworkCapability,
    listFrameworks,
    supportsRuntime
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import OverflowMenu, { type OverflowMenuEntry } from '@/components/OverflowMenu'
import { useProductConfirm } from '@/components/ProductConfirmDialog'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import { StatusTag, statusLabel, statusTone } from '@/components/Tag'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { FrameworkLogo, frameworkLabel } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'

// The frameworks a cloud computer installs on demand (ADR-0035): the coding
// CLIs. Service frameworks follow once the host's daemon supervises services.
const installable = (): AgentFramework[] =>
    listFrameworks().filter(
        (framework) =>
            frameworkCapability(framework).kind === 'coding' &&
            supportsRuntime(framework, 'k8s')
    )

const gib = (mb: number): string => String(Math.round((mb / 1024) * 10) / 10)

// Cloud computers (Kubernetes pod hosts) with what runs on them, and the
// operations on the machine itself. Shared by the editions' Cloud computers
// pages, which differ only in how a new one comes to exist.
const PodHostList: FC<{
    hosts: PodHostSummary[]
    onChanged: () => Promise<void>
}> = ({ hosts, onChanged }): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const { confirm, confirmDialog } = useProductConfirm()
    const [busy, setBusy] = useState<Record<string, string>>({})
    const [error, setError] = useState<string | null>(null)

    const run = async (
        hostId: string,
        label: string,
        work: () => Promise<unknown>
    ): Promise<void> => {
        setError(null)
        setBusy((prev) => ({ ...prev, [hostId]: label }))
        try {
            await work()
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setBusy((prev) => {
                const next = { ...prev }
                delete next[hostId]
                return next
            })
            await onChanged()
        }
    }

    const remove = async (host: PodHostSummary): Promise<void> => {
        const confirmed = await confirm({
            title: t('web.cloudComputers.deleteTitle', { name: host.name }),
            description: t('web.cloudComputers.deleteDescription'),
            confirmLabel: t('web.cloudComputers.delete'),
            tone: 'danger',
            requireMatch: host.name
        })
        if (!confirmed) return
        await run(host.id, t('web.cloudComputers.deleting'), () =>
            client.podHosts.delete(host.id)
        )
    }

    const menuFor = (host: PodHostSummary): OverflowMenuEntry[] => {
        const installed = new Set(host.runtimes.map((r) => r.framework))
        const entries: OverflowMenuEntry[] = installable()
            .filter((framework) => !installed.has(framework))
            .map((framework) => {
                const cli = frameworkLabel(framework)
                return {
                    label: t('web.cloudComputers.install', { cli }),
                    disabled: host.status !== 'ready',
                    onSelect: () =>
                        void run(
                            host.id,
                            t('web.cloudComputers.installing', { cli }),
                            () =>
                                client.podHosts.prepareRuntime(
                                    host.id,
                                    framework
                                )
                        )
                }
            })
        if (host.cliUpdateAvailable && host.latestCliVersion)
            entries.push({
                label: t('web.cloudComputers.updateCli', {
                    version: host.latestCliVersion
                }),
                onSelect: () =>
                    void run(host.id, t('web.cloudComputers.updating'), () =>
                        client.podHosts.upgradeCli(host.id)
                    )
            })
        if (entries.length > 0) entries.push({ separator: true })
        entries.push({
            label: t('web.cloudComputers.delete'),
            danger: true,
            disabled: host.status === 'provisioning',
            onSelect: () => void remove(host)
        })
        return entries
    }

    return (
        <>
            {error && <div className='workbench-alert-error mb-4'>{error}</div>}
            <div className='settings-card'>
                {hosts.map((host) => (
                    <div key={host.id} className='settings-card-row'>
                        <div className='flex min-w-0 flex-1 items-start justify-between gap-3'>
                            <div className='min-w-0'>
                                <div className='flex min-w-0 flex-wrap items-center gap-2'>
                                    <span className='settings-card-label'>
                                        {host.name}
                                    </span>
                                    <StatusTag
                                        tone={statusTone(host.status)}
                                        label={statusLabel(host.status, t)}
                                    />
                                </div>
                                <div className='settings-card-copy'>
                                    {host.cpuMillicores !== null &&
                                        host.memoryMb !== null &&
                                        host.diskGb !== null && (
                                            <span>
                                                {t(
                                                    'web.cloudComputers.resources',
                                                    {
                                                        cpu: String(
                                                            host.cpuMillicores /
                                                                1000
                                                        ),
                                                        memory: gib(
                                                            host.memoryMb
                                                        ),
                                                        disk: String(
                                                            host.diskGb
                                                        )
                                                    }
                                                )}
                                            </span>
                                        )}
                                    {host.cliVersion && (
                                        <>
                                            <span> · </span>
                                            <span>
                                                {t('web.cloudComputers.cli', {
                                                    version: host.cliVersion
                                                })}
                                            </span>
                                        </>
                                    )}
                                </div>
                                <div className='text-caption text-subtle mt-2 flex flex-wrap items-center gap-2'>
                                    {host.runtimes.length === 0 ? (
                                        <span>
                                            {host.status === 'provisioning'
                                                ? t(
                                                      'web.cloudComputers.starting'
                                                  )
                                                : t(
                                                      'web.cloudComputers.noFrameworks'
                                                  )}
                                        </span>
                                    ) : (
                                        host.runtimes.map((runtime) => (
                                            <ShortcutTooltip
                                                key={runtime.id}
                                                label={frameworkLabel(
                                                    runtime.framework
                                                )}
                                            >
                                                <Link
                                                    to={`/settings/runtimes/${runtime.id}`}
                                                    className='inline-flex items-center gap-1.5 hover:text-link'
                                                >
                                                    <FrameworkLogo
                                                        framework={
                                                            runtime.framework
                                                        }
                                                        size={16}
                                                    />
                                                    <span>
                                                        {runtime.frameworkVersion ??
                                                            statusLabel(
                                                                runtime.status,
                                                                t
                                                            )}
                                                    </span>
                                                </Link>
                                            </ShortcutTooltip>
                                        ))
                                    )}
                                    <span>
                                        {t('web.cloudComputers.contains', {
                                            count: String(host.agentsCount)
                                        })}
                                    </span>
                                    {busy[host.id] && (
                                        <span>{busy[host.id]}</span>
                                    )}
                                    {host.failureReason && (
                                        <span className='text-workflow-ship'>
                                            {host.failureReason}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <OverflowMenu items={menuFor(host)} compact />
                        </div>
                    </div>
                ))}
            </div>
            {confirmDialog}
        </>
    )
}

export default PodHostList
