import type { FC, ReactNode } from 'react'
import { useRef } from 'react'
import type { SdkAgent } from '@manyfold/sdk'
import { Link } from 'react-router-dom'
import {
    AutomationsIcon,
    CustomizeIcon,
    GlobeIcon,
    McpIcon,
    NetworkIcon,
    ProviderIcon
} from '@/components/icons'
import { Tag } from '@/components/Tag'
import { ChannelProviderIcon, channelLabel } from '@/lib/channelMeta'
import { wireProvider } from '@/lib/newChannelOptions'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import type { CreateProviderChoice } from '@/lib/newChannelOptions'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    newChatLaunchpadConfigFor,
    pickChannelProvider,
    type NewChatActionId
} from '@/lib/newChatLaunchpad'

// The draw has to survive re-render: this sits inside the chat page, which
// re-renders on every stream tick, and a provider that changed under the
// reader's cursor would look broken rather than varied. One draw per mount,
// redrawn only when the language moves the pool.
const useChannelProvider = (language: string): CreateProviderChoice => {
    const drawn = useRef<{
        language: string
        provider: CreateProviderChoice
    } | null>(null)
    if (!drawn.current || drawn.current.language !== language)
        drawn.current = { language, provider: pickChannelProvider(language) }
    return drawn.current.provider
}

// Two of these ship under a Chinese name their own users say out loud, and the
// catalog already localises WeChat that way. `channelLabel` cannot answer for
// Feishu at all — there it is a region of Lark, not a provider of its own.
// The zh title omits the space before the placeholder because zh only ever
// resolves to one of these two Chinese names; point zh at a Latin-named
// provider and that copy needs the space back.
const channelBrand = (
    provider: CreateProviderChoice,
    language: string
): string => {
    if (provider === 'feishu') return language === 'zh' ? '飞书' : 'Feishu'
    if (provider === 'weixin' && language === 'zh') return '微信'
    return channelLabel(provider)
}

interface Props {
    agent: SdkAgent
}

// One line, and only one. The header above carries the agent's name and its
// live runtime state, and the composer placeholder below names it again, so
// anything more here either repeats those or contradicts them.
export const NewChatLaunchpadIntro: FC = (): ReactNode => {
    const { t } = useI18n()

    return (
        <div className='mx-auto mb-7 max-w-3xl text-center'>
            <h2 className='text-display text-fg'>
                {t('web.chat.launchpad.heading')}
            </h2>
        </div>
    )
}

interface ActionView {
    Icon: FC<{ className?: string }>
    title: string
    body: string
    label: string
    to: string
}

const actionView = (
    id: NewChatActionId,
    agent: SdkAgent,
    provider: CreateProviderChoice,
    language: string,
    t: TFn
): ActionView => {
    const copy = (field: 'title' | 'body'): string =>
        t(`web.chat.launchpad.actions.${id}.${field}`)
    const shared = { title: copy('title'), body: copy('body') }
    switch (id) {
        case 'github':
            return {
                ...shared,
                Icon: CustomizeIcon,
                label: t('web.chat.launchpad.actions.configure'),
                // The agent's own Connections tab can only bind a connection
                // that already exists — its picker is empty for exactly the
                // reader this row is written for. Creating one lives here.
                to: '/connections'
            }
        case 'skills':
            return {
                ...shared,
                Icon: CustomizeIcon,
                label: t('web.chat.launchpad.actions.view'),
                to: agentSettingsPath(agent.id, 'skills')
            }
        case 'mcp':
            return {
                ...shared,
                Icon: McpIcon,
                label: t('web.chat.launchpad.actions.view'),
                to: agentSettingsPath(agent.id, 'mcp')
            }
        case 'channel':
            return {
                ...shared,
                title: t('web.chat.launchpad.actions.channel.title', {
                    provider: channelBrand(provider, language)
                }),
                Icon: GlobeIcon,
                label: t('web.chat.launchpad.actions.connect'),
                to: `/settings/channels/new/${provider}?agent=${encodeURIComponent(agent.id)}`
            }
        case 'automation':
            return {
                ...shared,
                Icon: AutomationsIcon,
                label: t('web.chat.launchpad.actions.create'),
                to: `/automations?agent=${encodeURIComponent(agent.id)}`
            }
        case 'native':
            return {
                ...shared,
                Icon: GlobeIcon,
                label: t('web.chat.launchpad.actions.open'),
                to: agentSettingsPath(agent.id)
            }
        case 'provider':
            return {
                ...shared,
                Icon: ProviderIcon,
                label: t('web.chat.launchpad.actions.check'),
                to: '/settings/runtimes/external-agent-providers'
            }
        case 'a2a':
            return {
                ...shared,
                Icon: NetworkIcon,
                label: t('web.chat.launchpad.actions.configure'),
                to: agentSettingsPath(agent.id, 'a2a')
            }
    }
}

// Seen on local dev [2026-09-10]: the shared `focus-visible:shadow-focus`
// utility composes to a fully transparent box-shadow even though --tw-shadow
// carries the right value, so the rows keep the native outline as their
// visible keyboard indicator instead of suppressing it with outline-none.
const NewChatLaunchpad: FC<Props> = ({ agent }): ReactNode => {
    const { language, t } = useI18n()
    const provider = useChannelProvider(language)
    const config = newChatLaunchpadConfigFor(agent.framework)
    if (!config) return null

    return (
        <div className='mx-auto mt-6 w-full max-w-3xl text-left'>
            <section aria-labelledby='new-chat-workflow-title'>
                <h3
                    id='new-chat-workflow-title'
                    className='text-ui text-fg font-medium'
                >
                    {t('web.chat.launchpad.workflowTitle')}
                </h3>
                <div className='mt-1'>
                    {config.actionIds.map((id) => {
                        const action = actionView(
                            id,
                            agent,
                            provider,
                            language,
                            t
                        )
                        const Icon = action.Icon
                        return (
                            <Link
                                key={id}
                                to={action.to}
                                className='hover:bg-surface-hover focus-visible:shadow-focus group flex items-center gap-3 rounded-sm px-3 py-2.5 transition-[color,background-color,box-shadow]'
                            >
                                {id === 'channel' ? (
                                    <ChannelProviderIcon
                                        provider={wireProvider(provider)}
                                        className='h-5 w-5 shrink-0'
                                    />
                                ) : (
                                    <Icon className='text-muted h-5 w-5 shrink-0' />
                                )}
                                <div className='min-w-0 flex-1'>
                                    <div className='flex flex-wrap items-center gap-2'>
                                        <span className='text-ui text-fg font-medium'>
                                            {action.title}
                                        </span>
                                        {id === config.recommended && (
                                            <Tag>
                                                {t(
                                                    'web.chat.launchpad.recommended'
                                                )}
                                            </Tag>
                                        )}
                                    </div>
                                    <p className='text-caption text-subtle mt-0.5'>
                                        {action.body}
                                    </p>
                                </div>
                                <span className='text-link group-hover:text-fg text-ui shrink-0 transition-colors'>
                                    {action.label}
                                </span>
                            </Link>
                        )
                    })}
                </div>
            </section>
        </div>
    )
}

export default NewChatLaunchpad
