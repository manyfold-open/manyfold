import type { FC, ReactNode } from 'react'
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
import { ChannelProviderIcon } from '@/lib/channelMeta'
import { agentSettingsPath } from '@/lib/agentSettingsPath'
import { useI18n, type TFn } from '@/lib/i18n'
import {
    newChatLaunchpadConfigFor,
    type NewChatActionId
} from '@/lib/newChatLaunchpad'

interface Props {
    agent: SdkAgent
    onSelectPrompt: (prompt: string) => void
    // Selecting a prompt replaces the composer, so the examples step aside
    // once there is a draft to lose.
    showPrompts: boolean
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
                to: agentSettingsPath(agent.id, 'connections')
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
        case 'channel': {
            // Feishu and Lark create the same channel; the region is a URL
            // segment, so the reader's language picks the likelier tenant.
            const provider = language === 'zh' ? 'feishu' : 'lark'
            return {
                ...shared,
                Icon: GlobeIcon,
                label: t('web.chat.launchpad.actions.connect'),
                to: `/settings/channels/new/${provider}?agent=${encodeURIComponent(agent.id)}`
            }
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
const NewChatLaunchpad: FC<Props> = ({
    agent,
    onSelectPrompt,
    showPrompts
}): ReactNode => {
    const { language, t } = useI18n()
    const config = newChatLaunchpadConfigFor(agent.framework)
    if (!config) return null

    return (
        <div className='mx-auto mt-6 w-full max-w-3xl text-left'>
            {showPrompts && (
                <section aria-labelledby='new-chat-prompts-title'>
                    <h3
                        id='new-chat-prompts-title'
                        className='text-ui text-fg font-medium'
                    >
                        {t('web.chat.launchpad.tryTask')}
                    </h3>
                    <div className='mt-1'>
                        {config.promptKeys.map((key) => {
                            const prompt = t(key)
                            return (
                                <button
                                    key={key}
                                    type='button'
                                    onClick={() => onSelectPrompt(prompt)}
                                    className='text-ui text-muted hover:text-fg hover:bg-surface-hover focus-visible:shadow-focus block w-full rounded-sm px-3 py-2.5 text-left transition-[color,background-color,box-shadow]'
                                >
                                    {prompt}
                                </button>
                            )
                        })}
                    </div>
                </section>
            )}

            <section
                aria-labelledby='new-chat-workflow-title'
                className={
                    showPrompts
                        ? 'border-divider/60 mt-5 border-t pt-5'
                        : undefined
                }
            >
                <h3
                    id='new-chat-workflow-title'
                    className='text-ui text-fg font-medium'
                >
                    {t('web.chat.launchpad.workflowTitle')}
                </h3>
                <div className='mt-1'>
                    {config.actionIds.map((id) => {
                        const action = actionView(id, agent, language, t)
                        const Icon = action.Icon
                        return (
                            <Link
                                key={id}
                                to={action.to}
                                className='hover:bg-surface-hover focus-visible:shadow-focus group flex items-center gap-3 rounded-sm px-3 py-2.5 transition-[color,background-color,box-shadow]'
                            >
                                {id === 'channel' ? (
                                    <ChannelProviderIcon
                                        provider='lark'
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
