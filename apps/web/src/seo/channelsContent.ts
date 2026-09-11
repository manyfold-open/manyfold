import type { ChannelProviderName } from '@manyfold/shared'
import { channelLabel } from '@/lib/channelMeta'

// The channels page's content tables, here rather than in the page for the
// same reason landingContent.ts exists: the crawler snapshot and the
// interactive page have to name the same apps in the same groups, and a
// second copy of the list is how they stop doing that.

/* The tile used to carry what the setup asks for — scan a code, paste a key,
   install an app — on the theory that a visitor wants it before they pick.
   They do not: by the time somebody is reading this grid they are looking for
   the name of the app their team uses, and the credential its API happens to
   want is a fact for the guide, one click away, where the whole procedure
   lives. On the tile it was a second line competing with the only thing the
   tile is for. */
export interface ChannelTileGroup {
    labelKey: string
    providers: ChannelProviderName[]
}

/* Grouped by where the conversation happens, not by what the setup costs.
   A visitor knows the name of the app their team uses; they do not know which
   credential its API happens to want, so grouping by setup would ask them for
   the answer before they could look it up.

   The line between the first two groups is whether you get there through a
   space somebody administers — a Slack workspace, a Microsoft 365 tenant, a
   Google Workspace domain, a Discord server, a Matrix homeserver — or through
   the messenger on your own phone.
   It is not a nicety: WeChat could not sit in the first group even if we
   wanted it to, because its bots are direct-message only and cannot join a
   group at all. Trackers are third because an issue is not a chat.

   Recognition orders each group, so the names that carry this page — Slack,
   WhatsApp, GitHub — are the ones the eye lands on first. */
export const CHANNEL_TILE_GROUPS: ChannelTileGroup[] = [
    {
        labelKey: 'web.channelsPage.appsGroupTeam',
        providers: [
            'slack',
            'msteams',
            'lark',
            'googlechat',
            'discord',
            'matrix'
        ]
    },
    {
        labelKey: 'web.channelsPage.appsGroupMessenger',
        providers: ['whatsapp', 'weixin', 'telegram', 'imessage', 'line']
    },
    {
        labelKey: 'web.channelsPage.appsGroupTracker',
        providers: ['github', 'linear']
    }
]

/* channelMeta labels a lark channel "Lark" because that is the provider name
   the product stores; the marketing page has to name both consoles, because
   a Feishu tenant searching this page for "飞书" finds nothing otherwise. */
export const channelTileLabel = (provider: ChannelProviderName): string =>
    provider === 'lark' ? 'Lark / Feishu' : channelLabel(provider)

/* The three steps, keyed. The live page and the snapshot both walk this, so
   the aside on the third step cannot go missing from one of them. */
export const CHANNEL_STEP_KEYS: Array<{
    title: string
    body: string
    note?: string
}> = [
    {
        title: 'web.channelsPage.step1Title',
        body: 'web.channelsPage.step1Body'
    },
    {
        title: 'web.channelsPage.step2Title',
        body: 'web.channelsPage.step2Body'
    },
    {
        title: 'web.channelsPage.step3Title',
        body: 'web.channelsPage.step3Body',
        note: 'web.channelsPage.step3Note'
    }
]

/* The closing screen's four claims, in the order the page makes them. Key
   fragments rather than whole keys, the way the page has always built them. */
export const CHANNEL_SYNC_POINTS = [
    'History',
    'Files',
    'Bill',
    'Settings'
] as const
