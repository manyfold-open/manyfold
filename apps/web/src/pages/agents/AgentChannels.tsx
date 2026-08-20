import type { ChannelSummary } from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { SdkAgent } from '@manyfold/sdk'
import { t } from '@manyfold/i18n'
import { EffectTimingTag } from '@/pages/AgentSettings/SectionHeader'
import EmptyState from '@/components/EmptyState'
import { Ghost } from '@/components/Loading'
import { StatusTag, statusTone } from '@/components/Tag'
import { useApiClient } from '@/lib/apiClient'
import { ChannelProviderIcon, channelLabel } from '@/lib/channelMeta'
import { apiErrorMessage } from '@/lib/errorMessage'

interface Props {
    agent: SdkAgent
}

const channelStatusLabel = (status: ChannelSummary['status']): string =>
    t(`web.agents.detail.channels.status.${status}`)

export const AgentChannels: FC<Props> = ({ agent }): ReactNode => {
    const client = useApiClient()
    const navigate = useNavigate()
    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let active = true
        setLoading(true)
        setError(null)
        void client.channels
            .list()
            .then((list) => {
                if (active) setChannels(list)
            })
            .catch((err) => {
                if (active) setError(apiErrorMessage(err))
            })
            .finally(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [client])

    const agentChannels = useMemo(
        () => channels.filter((channel) => channel.agentId === agent.id),
        [agent.id, channels]
    )
    const settingsUrl = `/settings/channels?agent=${encodeURIComponent(agent.id)}`

    return (
        <section>
            <header className='mb-4'>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2'>
                    <h2 className='text-h3 text-fg tracking-tight'>
                        {t('web.agents.detail.channels.title')}
                    </h2>
                    <span className='flex-1' />
                    <EffectTimingTag timing='immediate' />
                </div>
                <p className='text-caption text-muted mt-1.5'>
                    {t('web.agents.detail.channels.description')}{' '}
                    <Link className='text-link hover:text-fg' to={settingsUrl}>
                        {t('web.agents.detail.channels.settingsLink')}
                    </Link>
                    .
                </p>
            </header>

            {loading ? (
                <div
                    className='workbench-panel space-y-3 px-4 py-4'
                    aria-busy='true'
                >
                    <Ghost variant='line' className='w-1/3' />
                    <Ghost variant='cap' className='w-3/5' />
                    <Ghost variant='cap' className='w-2/5' />
                </div>
            ) : error ? (
                <div className='workbench-alert-error'>{error}</div>
            ) : agentChannels.length === 0 ? (
                <EmptyState
                    kind='first-use'
                    tier='stack'
                    title={t('web.agents.detail.channels.emptyTitle')}
                    body={t('web.agents.detail.channels.emptyBody')}
                    action={{
                        label: t('web.agents.detail.channels.emptyAction'),
                        onClick: () => navigate(settingsUrl)
                    }}
                />
            ) : (
                <ul className='workbench-panel divide-divider divide-y overflow-hidden'>
                    {agentChannels.map((channel) => (
                        <li key={channel.id}>
                            <Link
                                to={`/settings/channels/${channel.id}`}
                                className='hover:bg-surface-hover flex items-start gap-3 px-5 py-4 transition-colors'
                            >
                                <ChannelProviderIcon
                                    provider={channel.provider}
                                    className='mt-0.5 h-5 w-5 shrink-0'
                                />
                                <span className='min-w-0 flex-1'>
                                    <span className='text-ui text-fg block truncate font-medium'>
                                        {channel.label}
                                    </span>
                                    <span className='text-caption text-subtle block truncate'>
                                        {channelLabel(channel.provider)}
                                    </span>
                                    {channel.status === 'error' &&
                                    channel.lastErrorMessage ? (
                                        <span className='text-caption text-error mt-1 block'>
                                            {channel.lastErrorMessage}
                                        </span>
                                    ) : null}
                                </span>
                                <StatusTag
                                    tone={statusTone(channel.status)}
                                    label={channelStatusLabel(channel.status)}
                                    className='mt-0.5 shrink-0'
                                />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}
