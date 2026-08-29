import type { ChannelProviderName, LarkAppRegion } from '@manyfold/shared'
import { channelLabel } from '@/lib/channelMeta'

// A channel's provider is picked once, up front, and becomes a URL segment.
// Feishu and Lark are two rows even though both create a `lark` channel: the
// region is a config field, and asking for it later would mean asking after
// the app credentials it decides the shape of.
export type CreateProviderChoice = ChannelProviderName | LarkAppRegion

export const isLarkProviderChoice = (
    provider: CreateProviderChoice
): provider is LarkAppRegion => provider === 'feishu' || provider === 'lark'

// The mark and the docs path are both keyed by the wire provider, so a region
// choice normalises back to `lark` for either lookup.
export const wireProvider = (
    provider: CreateProviderChoice
): ChannelProviderName => (isLarkProviderChoice(provider) ? 'lark' : provider)

export interface NewChannelOption {
    provider: CreateProviderChoice
    to: string
    label: string
}

const CREATE_PROVIDERS: CreateProviderChoice[] = [
    'feishu',
    'lark',
    'telegram',
    'slack',
    'discord',
    'matrix',
    'weixin',
    'whatsapp',
    'linear',
    'github',
    'line'
]

export const isCreateProvider = (
    value: string | undefined
): value is CreateProviderChoice =>
    value !== undefined && (CREATE_PROVIDERS as string[]).includes(value)

// Single source for "where does a new channel of this provider get created" —
// consumed by the rail header, the rail footer and the dashboard, so the three
// cannot come to offer different providers. `fake` is deliberately absent.
export const NEW_CHANNEL_OPTIONS: NewChannelOption[] = CREATE_PROVIDERS.map(
    (provider) => ({
        provider,
        to: `/settings/channels/new/${provider}`,
        // Provider names are brands, not copy: Feishu is the only one the
        // channel meta cannot label, because there it is a region of Lark.
        label: provider === 'feishu' ? 'Feishu' : channelLabel(provider)
    })
)
