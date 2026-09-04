import type { UserConnectionSummary } from '@manyfold/shared'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import WorkbenchSelect from '@/components/WorkbenchSelect'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { connectionProviderLabel } from '../Customize/connectionMeta'

interface Props {
    agent: SdkAgent
    onAgentUpdated: (agent: SdkAgent) => void
}

interface AgentExtras {
    githubConnectionId?: string | null
    cloudflareConnectionId?: string | null
    composioConnectionId?: string | null
}

export const AgentConnections: FC<Props> = ({ agent, onAgentUpdated }) => {
    const client = useApiClient()
    const [conns, setConns] = useState<UserConnectionSummary[]>([])
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const extras = (agent.extras ?? {}) as AgentExtras
    const githubId = extras.githubConnectionId ?? ''
    const cloudflareId = extras.cloudflareConnectionId ?? ''
    const composioId = extras.composioConnectionId ?? ''

    useEffect(() => {
        let active = true
        void client.connections
            .list()
            .then((list) => {
                if (active) setConns(list)
            })
            .catch((err) => {
                if (active) setError(apiErrorMessage(err))
            })
        return () => {
            active = false
        }
    }, [client])

    const github = useMemo(
        () => conns.filter((c) => c.provider === 'github'),
        [conns]
    )
    const cloudflare = useMemo(
        () => conns.filter((c) => c.provider === 'cloudflare'),
        [conns]
    )
    const composio = useMemo(
        () => conns.filter((c) => c.provider === 'composio'),
        [conns]
    )

    const save = async (patch: {
        githubConnectionId?: string | null
        cloudflareConnectionId?: string | null
        composioConnectionId?: string | null
    }): Promise<void> => {
        setSaving(true)
        setError(null)
        try {
            onAgentUpdated(await client.agents.update(agent.id, patch))
        } catch (err) {
            setError(apiErrorMessage(err))
        } finally {
            setSaving(false)
        }
    }

    // Service frameworks never mount this pane: the section gate hides
    // Connections for them with a framework precondition (#781).

    return (
        <section>
            <header className='mb-4'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg'>
                        {t('web.agents.detail.connections.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='immediate' />
                </div>
                <p className='text-caption text-muted mt-1.5'>
                    {t('web.agents.detail.connections.description')}{' '}
                    <Link
                        className='text-link hover:text-fg'
                        to='/connections'
                    >
                        {t('web.agents.detail.connections.settingsLink')}
                    </Link>
                    .
                </p>
            </header>
            {error ? (
                <div className='workbench-alert-error mb-4'>{error}</div>
            ) : null}
            <div className='grid gap-4 md:grid-cols-2'>
                <div className='block'>
                    <span className='text-caption text-subtle mb-1.5 block'>
                        {connectionProviderLabel('github')}
                    </span>
                    <WorkbenchSelect
                        ariaLabel={t(
                            'web.agents.detail.connections.githubAria'
                        )}
                        value={githubId}
                        disabled={saving}
                        onChange={(next) =>
                            void save({ githubConnectionId: next || null })
                        }
                        options={[
                            {
                                value: '',
                                label: t('web.agents.detail.connections.none')
                            },
                            ...github.map((c) => ({
                                value: c.id,
                                label: c.displayName
                            }))
                        ]}
                    />
                </div>
                <div className='block'>
                    <span className='text-caption text-subtle mb-1.5 block'>
                        {connectionProviderLabel('cloudflare')}
                    </span>
                    <WorkbenchSelect
                        ariaLabel={t(
                            'web.agents.detail.connections.cloudflareAria'
                        )}
                        value={cloudflareId}
                        disabled={saving}
                        onChange={(next) =>
                            void save({ cloudflareConnectionId: next || null })
                        }
                        options={[
                            {
                                value: '',
                                label: t('web.agents.detail.connections.none')
                            },
                            ...cloudflare.map((c) => ({
                                value: c.id,
                                label: c.displayName
                            }))
                        ]}
                    />
                </div>
                <div className='block'>
                    <span className='text-caption text-subtle mb-1.5 block'>
                        {connectionProviderLabel('composio')}
                    </span>
                    <WorkbenchSelect
                        ariaLabel={t(
                            'web.agents.detail.connections.composioAria'
                        )}
                        value={composioId}
                        disabled={saving}
                        onChange={(next) =>
                            void save({ composioConnectionId: next || null })
                        }
                        options={[
                            {
                                value: '',
                                label: t('web.agents.detail.connections.none')
                            },
                            ...composio.map((c) => ({
                                value: c.id,
                                label: c.displayName
                            }))
                        ]}
                    />
                </div>
            </div>
        </section>
    )
}
