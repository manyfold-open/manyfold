import type { ChannelProviderName } from '@manyfold/shared'
import { channelLabel } from '@/lib/channelMeta'

// The channels page's content tables, here rather than in the page for the
// same reason landingContent.ts exists: the crawler snapshot and the
// interactive page have to name the same apps in the same groups, and a
// second copy of the list is how they stop doing that.

/* Three ways in, and they are what the setup actually asks for: a QR code
   scanned from the app, a bot token pasted from its console, or an app the
   platform installs from a manifest Manyfold generates. Which of the three
   it is happens to be the fact a visitor wants before they pick one, so it
   rides on the tile instead of staying in the docs. */
export type ChannelSetupKind = 'qr' | 'token' | 'app'

export interface ChannelTile {
    provider: ChannelProviderName
    setup: ChannelSetupKind
}

export interface ChannelTileGroup {
    labelKey: string
    tiles: ChannelTile[]
}

/* Grouped by where the conversation happens, not by what the setup costs.
   A visitor knows the name of the app their team uses; they do not know
   which credential its API happens to want, so grouping by setup would ask
   them for the answer before they could look it up. Effort stays on the
   tile, where it is a fact about one app rather than a way to find it.

   The line between the first two groups is whether you get there through a
   space somebody administers — a Slack workspace, a Lark tenant, a Discord
   server, a Matrix homeserver — or through the messenger on your own phone.
   It is not a nicety: WeChat could not sit in the first group even if we
   wanted it to, because its bots are direct-message only and cannot join a
   group at all. Trackers are third because an issue is not a chat.

   Recognition orders each group, so the names that carry this page — Slack,
   WhatsApp, GitHub — are the ones the eye lands on first. */
export const CHANNEL_TILE_GROUPS: ChannelTileGroup[] = [
    {
        labelKey: 'web.channelsPage.appsGroupTeam',
        tiles: [
            { provider: 'slack', setup: 'app' },
            { provider: 'lark', setup: 'qr' },
            { provider: 'discord', setup: 'token' },
            { provider: 'matrix', setup: 'token' }
        ]
    },
    {
        labelKey: 'web.channelsPage.appsGroupMessenger',
        tiles: [
            { provider: 'whatsapp', setup: 'qr' },
            { provider: 'weixin', setup: 'qr' },
            { provider: 'telegram', setup: 'token' },
            { provider: 'line', setup: 'token' }
        ]
    },
    {
        labelKey: 'web.channelsPage.appsGroupTracker',
        tiles: [
            { provider: 'github', setup: 'app' },
            { provider: 'linear', setup: 'app' }
        ]
    }
]

export const CHANNEL_SETUP_LABEL: Record<ChannelSetupKind, string> = {
    qr: 'web.channelsPage.setupQr',
    token: 'web.channelsPage.setupToken',
    app: 'web.channelsPage.setupApp'
}

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
