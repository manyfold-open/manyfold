import type { AgentFramework, ChannelProviderName } from '@manyfold/shared'
// Shared between the interactive landing page and the build-time landing
// snapshot so the crawler HTML and the hydrated page cannot drift.

export interface PricingTier {
    id: 'free' | 'hobby' | 'plus' | 'pro'
    price: number
    sandboxAgents: number
    alwaysOnlineAgents: number
    featureKeys: string[]
    // The one tier the pricing grid leans on; carries the POPULAR badge.
    popular?: boolean
}

// Mirrors the authenticated billing plans (web.pricing.tier* strings are the
// single source of truth for copy). Kept static so the public landing page
// never needs the billing API.
export const PRICING_TIERS: PricingTier[] = [
    {
        id: 'free',
        price: 0,
        sandboxAgents: 3,
        alwaysOnlineAgents: 2,
        featureKeys: [
            'web.pricing.tierFreeFeatures.hours',
            'web.pricing.tierFreeFeatures.alwaysOnline',
            'web.pricing.tierFreeFeatures.channels',
            'web.pricing.tierFreeFeatures.api'
        ]
    },
    {
        id: 'hobby',
        price: 9,
        sandboxAgents: 10,
        alwaysOnlineAgents: 6,
        featureKeys: [
            'web.pricing.tierHobbyFeatures.hours',
            'web.pricing.tierHobbyFeatures.alwaysOnline',
            'web.pricing.tierHobbyFeatures.channels',
            'web.pricing.tierHobbyFeatures.api'
        ]
    },
    {
        id: 'plus',
        price: 19,
        popular: true,
        sandboxAgents: 25,
        alwaysOnlineAgents: 18,
        featureKeys: [
            'web.pricing.tierPlusFeatures.hours',
            'web.pricing.tierPlusFeatures.alwaysOnline',
            'web.pricing.tierPlusFeatures.channels',
            'web.pricing.tierPlusFeatures.history'
        ]
    },
    {
        id: 'pro',
        price: 49,
        sandboxAgents: 75,
        alwaysOnlineAgents: 54,
        featureKeys: [
            'web.pricing.tierProFeatures.hours',
            'web.pricing.tierProFeatures.alwaysOnline',
            'web.pricing.tierProFeatures.channels',
            'web.pricing.tierProFeatures.history'
        ]
    }
]

export const TIER_LABEL: Record<PricingTier['id'], string> = {
    free: 'Free',
    hobby: 'Hobby',
    plus: 'Plus',
    pro: 'Pro'
}

export const TIER_TAGLINE_KEY: Record<PricingTier['id'], string> = {
    free: 'web.pricing.tierFreeTagline',
    hobby: 'web.pricing.tierHobbyTagline',
    plus: 'web.pricing.tierPlusTagline',
    pro: 'web.pricing.tierProTagline'
}

export const FAQ_KEYS: Array<{ q: string; a: string }> = [
    { q: 'web.landing.faqQ1', a: 'web.landing.faqA1' },
    { q: 'web.landing.faqQ2', a: 'web.landing.faqA2' },
    { q: 'web.landing.faqQ3', a: 'web.landing.faqA3' },
    { q: 'web.landing.faqQ4', a: 'web.landing.faqA4' },
    { q: 'web.landing.faqQ5', a: 'web.landing.faqA5' }
]

// The "works with" rows. Product names render verbatim; the descriptive
// entries (runtime postures, the external-service catch-all) go through a
// translation key instead.
export interface WorksWithChip {
    name?: string
    key?: string
    soft?: boolean
    /* A mark makes the row scannable in a way a wall of pills is not: the eye
       finds a logo before it reads a word. Rows whose entries are capabilities
       rather than products (the runtimes) stay text — inventing marks for them
       would be decoration, not information. */
    framework?: AgentFramework
    channel?: ChannelProviderName
    /* Runtimes are capabilities, not products, so they carry a drawn icon
       rather than a vendor mark. */
    runtime?: 'sandbox' | 'cloud' | 'own' | 'external'
}

export const WORKS_WITH_ROWS: ReadonlyArray<{
    labelKey: string
    chips: ReadonlyArray<WorksWithChip>
}> = [
    /* Every framework the platform runs, not a curated six: the row's whole
       job is to let a reader find the one they already use, and a shortened
       list fails exactly the person it is meant to reassure. Dify and
       Langflow belong here rather than buried in the runtimes line — they
       are frameworks, and what makes them different is where they run, which
       the runtimes row already says. */
    {
        labelKey: 'web.landing.worksWithFrameworks',
        chips: [
            { name: 'Claude Code', framework: 'claude-code' },
            { name: 'Codex', framework: 'codex' },
            { name: 'Gemini CLI', framework: 'gemini-cli' },
            { name: 'Openclaw', framework: 'openclaw' },
            { name: 'Hermes', framework: 'hermes' },
            { name: 'NarraNexus', framework: 'narranexus' },
            { name: 'Dify', framework: 'dify' },
            { name: 'Langflow', framework: 'langflow' },
            { name: 'A2A', framework: 'a2a' }
        ]
    },
    {
        labelKey: 'web.landing.worksWithChannels',
        chips: [
            { name: 'Lark', channel: 'lark' },
            { name: 'Slack', channel: 'slack' },
            { name: 'Discord', channel: 'discord' },
            { name: 'Telegram', channel: 'telegram' },
            { name: 'WhatsApp', channel: 'whatsapp' },
            { name: 'Matrix', channel: 'matrix' },
            { name: 'WeChat', channel: 'weixin' },
            { name: 'LINE', channel: 'line' },
            { name: 'Linear', channel: 'linear' },
            { name: 'GitHub', channel: 'github' }
        ]
    },
    {
        labelKey: 'web.landing.worksWithRuntimes',
        chips: [
            { key: 'web.landing.worksWithSandbox', runtime: 'sandbox' },
            { key: 'web.landing.worksWithCloud', runtime: 'cloud' },
            { key: 'web.landing.worksWithOwn', runtime: 'own' },
            /* Reuses the world's own label so "external" needs no new string
               and arrives already translated in all eleven catalogues. */
            { key: 'web.landing.worldRuntimeExternal', runtime: 'external' }
        ]
    }
]
