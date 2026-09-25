import type { PodHostSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import EmptyState from '@/components/EmptyState'
import { CloudComputerIcon } from '@/components/icons'
import { GhostSettingsRows } from '@/components/Loading'
import PodHostList from '@/components/PodHostList'
import SettingsPageHeader from '@/components/SettingsPageHeader'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { useI18n } from '@/lib/i18n'

// A host still starting is re-read until it settles.
const STARTING_POLL_MS = 5_000

// Editions slot (§3.3): cloud computers on the cluster this install runs
// agents on, created here on demand. The cloud overlay shadows this page with
// one where a cloud computer is bought.
const CloudComputers: FC = (): ReactNode => {
    const { t } = useI18n()
    const client = useApiClient()
    const [hosts, setHosts] = useState<PodHostSummary[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [enabled, setEnabled] = useState<boolean | null>(null)
    const [creating, setCreating] = useState(false)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setHosts(await client.podHosts.list())
            setError(null)
        } catch (err) {
            setError(apiErrorMessage(err))
        }
    }, [client])

    useEffect(() => {
        client.runtimeAccess
            .summary()
            .then((s) => setEnabled(s.cloudComputerEnabled))
            .catch(() => setEnabled(false))
    }, [client])

    useEffect(() => {
        void refresh()
    }, [refresh])

    const starting = hosts?.some((h) => h.status === 'provisioning') ?? false
    useEffect(() => {
        if (!starting) return
        const timer = setInterval(() => void refresh(), STARTING_POLL_MS)
        return () => clearInterval(timer)
    }, [starting, refresh])

    const create = async (): Promise<void> => {
        setCreating(true)
        setError(null)
        try {
            await client.podHosts.create({})
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setCreating(false)
            await refresh()
        }
    }

    if (enabled === false) return <Navigate to='/settings/runtimes' replace />

    return (
        <div className='settings-page'>
            <SettingsPageHeader
                breadcrumb={[
                    {
                        label: t('web.settingsLayout.runtimes'),
                        to: '/settings/runtimes'
                    },
                    { label: t('web.cloudComputers.title') }
                ]}
                title={t('web.cloudComputers.title')}
                description={t('web.cloudComputers.description')}
                actions={
                    enabled === true ? (
                        <button
                            type='button'
                            className='workbench-button-primary h-9'
                            disabled={creating}
                            onClick={() => void create()}
                        >
                            {creating
                                ? t('web.cloudComputers.creating')
                                : t('web.cloudComputers.create')}
                        </button>
                    ) : undefined
                }
            />

            {error && <div className='workbench-alert-error mb-4'>{error}</div>}

            <section className='settings-section'>
                {hosts === null && !error && (
                    <div className='settings-card' aria-busy='true'>
                        <GhostSettingsRows rows={2} />
                    </div>
                )}
                {hosts !== null && hosts.length === 0 && (
                    <EmptyState
                        kind='first-use'
                        tier='stack'
                        icon={CloudComputerIcon}
                        body={t('web.cloudComputers.emptyCreate')}
                        {...(enabled === true
                            ? {
                                  action: {
                                      label: t('web.cloudComputers.create'),
                                      onClick: () => void create()
                                  }
                              }
                            : {})}
                    />
                )}
                {hosts !== null && hosts.length > 0 && (
                    <PodHostList hosts={hosts} onChanged={refresh} />
                )}
            </section>
        </div>
    )
}

export default CloudComputers
