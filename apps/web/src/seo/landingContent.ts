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
}

export const WORKS_WITH_ROWS: ReadonlyArray<{
    labelKey: string
    chips: ReadonlyArray<WorksWithChip>
}> = [
    {
        labelKey: 'web.landing.worksWithFrameworks',
        chips: [
            { name: 'Claude Code' },
            { name: 'Codex' },
            { name: 'Gemini CLI' },
            { name: 'Openclaw' },
            { name: 'Hermes' },
            { name: 'NarraNexus' }
        ]
    },
    {
        labelKey: 'web.landing.worksWithChannels',
        chips: [
            { name: 'Lark' },
            { name: 'Slack' },
            { name: 'Discord' },
            { name: 'Telegram' },
            { name: 'Matrix' },
            { name: 'WeChat' },
            { name: 'Linear' },
            { name: 'GitHub' }
        ]
    },
    {
        labelKey: 'web.landing.worksWithRuntimes',
        chips: [
            { key: 'web.landing.worksWithSandbox' },
            { key: 'web.landing.worksWithCloud' },
            { key: 'web.landing.worksWithOwn' },
            { key: 'web.landing.worksWithExternal', soft: true }
        ]
    }
]
