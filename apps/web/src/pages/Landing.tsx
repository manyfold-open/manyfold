import type { FC, ReactNode } from 'react'
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState
} from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import {
    ArrowRight,
    Blocks,
    Check,
    Cloud,
    HardDrive,
    Laptop,
    Plus,
    Sparkle
} from 'lucide-react'
import { ScrollyStage } from '@/components/landing/ScrollyStage'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import SignupGateModal from '@/components/signup-gate/SignupGateModal'
import AccessGateModal from '@/components/signup-gate/AccessGateModal'
import { useSignupGateFeature } from '@/components/signup-gate/useSignupGate'
import { useSignedInBilling, type PricingBilling } from '@/lib/landingBilling'
import { SignedIn, SignedOut, useAppAuth } from '@/lib/auth'
import {
    AnthropicMono,
    GeminiMono,
    OpenAIMono
} from '@/lib/brandIcons'
import { ChannelProviderIcon } from '@/lib/channelMeta'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { useI18n } from '@/lib/i18n'
import {
    FAQ_KEYS,
    PRICING_TIERS,
    TIER_LABEL,
    TIER_TAGLINE_KEY,
    WORKS_WITH_ROWS,
    type PricingTier
} from '@/seo/landingContent'
import { useMarketingLanguagePin } from '@/seo/useMarketingLanguagePin'
import BrandBetaBadge from '@/components/signup-gate/BrandBetaBadge'
import GateCtaLabel from '@/components/signup-gate/CtaLabel'

interface SignupGateContextValue {
    open: () => void
    openGate: () => void
    loaded: boolean
    enabled: boolean
}

const SignupGateContext = createContext<SignupGateContextValue>({
    open: () => {},
    openGate: () => {},
    loaded: false,
    enabled: false
})

const useSignupGate = (): SignupGateContextValue =>
    useContext(SignupGateContext)

const StepCtas: FC<{
    onRequestAccess: () => void
    onSignIn: () => void
}> = ({ onRequestAccess, onSignIn }): ReactNode => {
    const { t } = useI18n()
    return (
        <div className='lp-step-ctas'>
            <button
                type='button'
                onClick={onRequestAccess}
                className='lp-btn lp-btn-primary lp-step-cta'
            >
                <span className='lp-step-cta-badge'>
                    <span className='lp-step-cta-badge-full'>
                        {t('web.landing.stepCtaStep1')}
                    </span>
                    <span className='lp-step-cta-badge-num'>1</span>
                </span>
                <span className='lp-step-cta-label'>
                    <GateCtaLabel />
                </span>
            </button>
            <span className='lp-step-cta-arrow' aria-hidden='true'>
                <ArrowRight />
            </span>
            <button
                type='button'
                onClick={onSignIn}
                className='lp-btn lp-btn-secondary lp-step-cta'
            >
                <span className='lp-step-cta-badge'>
                    <span className='lp-step-cta-badge-full'>
                        {t('web.landing.stepCtaStep2')}
                    </span>
                    <span className='lp-step-cta-badge-num'>2</span>
                </span>
                <span className='lp-step-cta-label'>
                    {t('web.landing.signIn')}
                </span>
            </button>
        </div>
    )
}

// Signed-out hero/footer CTA: the gated two-step flow when the feature
// toggle is on, the plain direct sign-up CTA when it is off.
const SignedOutCtas: FC = (): ReactNode => {
    const { t } = useI18n()
    const gate = useSignupGate()
    if (!gate.loaded) return null
    if (!gate.enabled)
        return (
            <Link to='/login' className='lp-btn lp-btn-primary'>
                {t('web.landing.heroPrimaryCta')}
                <ArrowRight className='lp-arr' />
            </Link>
        )
    return <StepCtas onRequestAccess={gate.open} onSignIn={gate.openGate} />
}

const LandingBrandBadge: FC = (): ReactNode => {
    const gate = useSignupGate()
    if (!gate.enabled) return null
    return <BrandBetaBadge />
}

/* The desktop nav carries no CTA. With the header not following the scroll
   (see .lp-nav in styles.css), a button up there is visible over exactly the
   same stretch as the hero's — the two rendered the identical label on the
   identical screen, and the nav copy was competing with the hero for the one
   focal point that fold is supposed to have. Reach is unaffected: the hero,
   each pricing card, and the closing card all carry one.

   The More menu keeps its CTA (`LandingOverflowCta` below): a menu's job is to
   hold every entrance, and it opens as an overlay, so it never sits beside the
   hero button the way the desktop bar did. */
const LandingOverflowCta: FC<{ close: () => void }> = ({
    close
}): ReactNode => {
    const { t } = useI18n()
    const gate = useSignupGate()
    return (
        <>
            {gate.loaded && !gate.enabled ? (
                <SignedOut>
                    <Link
                        to='/login'
                        className='lp-nav-menu-item lp-nav-menu-item-cta'
                        role='menuitem'
                        onClick={close}
                    >
                        <ArrowRight />
                        <span>{t('web.landing.heroPrimaryCta')}</span>
                    </Link>
                    <Link
                        to='/login'
                        className='lp-nav-menu-item'
                        role='menuitem'
                        onClick={close}
                    >
                        <span>{t('web.landing.signIn')}</span>
                    </Link>
                </SignedOut>
            ) : null}
            {gate.loaded && gate.enabled ? (
                <SignedOut>
                    <button
                        type='button'
                        className='lp-nav-menu-item lp-nav-menu-item-cta'
                        role='menuitem'
                        onClick={() => {
                            close()
                            gate.open()
                        }}
                    >
                        <ArrowRight />
                        <span>
                            <GateCtaLabel />
                        </span>
                    </button>
                    <button
                        type='button'
                        className='lp-nav-menu-item'
                        role='menuitem'
                        onClick={() => {
                            close()
                            gate.openGate()
                        }}
                    >
                        <span>{t('web.landing.signIn')}</span>
                    </button>
                </SignedOut>
            ) : null}
            <SignedIn>
                <Link
                    to='/workspace'
                    className='lp-nav-menu-item lp-nav-menu-item-cta'
                    role='menuitem'
                    onClick={close}
                >
                    <ArrowRight />
                    <span>{t('web.landing.openWorkspace')}</span>
                </Link>
            </SignedIn>
        </>
    )
}

/* Vendor marks in the usage table run mono, not colour: the table is dense
   monospaced figures, and three saturated logos would out-shout the readings
   they are meant to label. */
const VENDOR_MARK = {
    anthropic: AnthropicMono,
    openai: OpenAIMono,
    google: GeminiMono
} as const

const VendorMark: FC<{ vendor: keyof typeof VENDOR_MARK }> = ({ vendor }) => {
    const Mark = VENDOR_MARK[vendor]
    return (
        <span className='lp-usage-mark' aria-hidden='true'>
            <Mark size={13} />
        </span>
    )
}

const RUNTIME_ICON = {
    sandbox: HardDrive,
    cloud: Cloud,
    own: Laptop,
    external: Blocks
} as const

// Three rows of what plugs in: the frameworks that run, the channels that
// deliver, the runtimes that host. Names are products, so only the row
// labels and the descriptive entries carry translations.
const WorksWith: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-works-with' className='lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.landing.worksWithEyebrow')}
                    </div>
                    <h2 className='lp-h2'>
                        {t('web.landing.worksWithTitle')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.worksWithTitleAccent')}
                        </span>
                    </h2>
                    <p className='lp-lead'>{t('web.landing.worksWithLead')}</p>
                </div>
                <div className='lp-ww'>
                    {WORKS_WITH_ROWS.map((row) => (
                        <div key={row.labelKey} className='lp-ww-row'>
                            <div className='lp-ww-k'>{t(row.labelKey)}</div>
                            {/* The track carries the list twice and travels
                                exactly one copy, so the seam never arrives.
                                A short row is padded out first: with four
                                items the repeat lands inside one viewport and
                                the loop becomes visible. Only the first copy
                                is read aloud. */}
                            <div className='lp-ww-v'>
                                <div className='lp-ww-track'>
                                    {[0, 1].map((copy) => (
                                        <div
                                            className='lp-ww-set'
                                            key={copy}
                                            aria-hidden={copy === 1}
                                        >
                                            {Array.from(
                                                {
                                                    length:
                                                        row.chips.length < 6
                                                            ? 3
                                                            : 1
                                                },
                                                (_, rep) => rep
                                            ).flatMap((rep) =>
                                                row.chips.map((chip) => ({
                                                    ...chip,
                                                    rep
                                                }))
                                            ).map((chip) => {
                                                const Runtime = chip.runtime
                                                    ? RUNTIME_ICON[chip.runtime]
                                                    : null
                                                return (
                                                    <span
                                                        key={`${chip.rep}-${chip.name ?? chip.key}`}
                                                        className='lp-chip'
                                                    >
                                                        {chip.framework ? (
                                                            <FrameworkLogo
                                                                framework={
                                                                    chip.framework
                                                                }
                                                                size={26}
                                                                className='lp-chip-mark'
                                                            />
                                                        ) : null}
                                                        {chip.channel ? (
                                                            <ChannelProviderIcon
                                                                provider={
                                                                    chip.channel
                                                                }
                                                                className='lp-chip-mark'
                                                            />
                                                        ) : null}
                                                        {Runtime ? (
                                                            <Runtime
                                                                className='lp-chip-mark lp-chip-drawn'
                                                                aria-hidden='true'
                                                            />
                                                        ) : null}
                                                        {chip.name ??
                                                            t(chip.key ?? '')}
                                                    </span>
                                                )
                                            })}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}

// Illustrative rows, not live data: the point of the panel is the shape of
// the ledger (per turn, per agent, per provider), so the numbers stay
// static and the copy beside it never claims they are yours.
const USAGE_ROWS: ReadonlyArray<{
    turn: string
    agent: string
    model: string
    tokens: string
    latency: string
    cost: string
    costValue: number
    vendor: 'anthropic' | 'openai' | 'google'
    ownKey?: boolean
}> = [
    {
        turn: '#142',
        agent: 'cc-review',
        model: 'claude-sonnet-5',
        vendor: 'anthropic',
        tokens: '38.2k',
        latency: '3.2s',
        cost: '$0.120',
        costValue: 0.12
    },
    {
        turn: '#141',
        agent: 'pr-bot',
        model: 'gpt-5-codex',
        vendor: 'openai',
        tokens: '8.1k',
        latency: '2.1s',
        cost: '$0.052',
        costValue: 0.052
    },
    {
        turn: '#140',
        agent: 'research-mate',
        model: 'gemini-2.5-pro',
        vendor: 'google',
        tokens: '21.4k',
        latency: '4.8s',
        cost: '$0.011',
        costValue: 0.011
    },
    {
        turn: '#139',
        agent: 'cc-review',
        model: 'sonnet-5',
        vendor: 'anthropic',
        tokens: '12.4k',
        latency: '2.9s',
        cost: '$0.084',
        costValue: 0.084,
        ownKey: true
    }
]

/* Observability, not metering. The section used to argue one thing — that a
   run's price is visible — and the three claims under it were all restatements
   of that. What a reader needs to trust an agent they cannot watch is broader:
   what it did, what that cost, and what it was allowed to touch.

   Three peers, so three columns rather than three stacked pairs: paired rows
   left a ragged column of artefacts at three different heights, and put a
   month-to-date figure at the head of a section that is no longer about
   money. The figure now sits in the column it belongs to. */
const TRANSCRIPT = [
    ['read', 'src/auth/session.ts'],
    ['edit', '3 files'],
    ['test', '18 passed']
] as const

const PERMISSIONS = [
    ['edit', 'src/auth/session.ts', true],
    ['run', 'pnpm test', true],
    ['run', 'rm -rf node_modules', false]
] as const

const Observability: FC = (): ReactNode => {
    const { t } = useI18n()
    const dearest = Math.max(...USAGE_ROWS.map((r) => r.costValue))
    const panels = [
        <div className='lp-ob-panel' key='transcript'>
            <div className='lp-ob-row'>
                <span className='lp-ob-who'>
                    <VendorMark vendor='anthropic' />
                    cc-review
                    <span className='lp-ob-dim'>#4</span>
                </span>
                <span className='lp-ob-dim'>2h</span>
            </div>
            {TRANSCRIPT.map(([verb, what]) => (
                <div className='lp-ob-step' key={what}>
                    <span className='lp-ob-verb'>{verb}</span>
                    <span className='lp-ob-dim'>{what}</span>
                </div>
            ))}
            <div className='lp-ob-step'>
                <span className='lp-ob-ok' aria-hidden='true'>
                    <Check />
                </span>
                <span className='lp-ob-dim'>PR #412</span>
            </div>
        </div>,
        <div className='lp-ob-panel' key='cost'>
            {USAGE_ROWS.slice(0, 3).map((row) => (
                <div className='lp-ob-row' key={row.turn}>
                    <span className='lp-ob-who'>
                        <VendorMark vendor={row.vendor} />
                        <span className='lp-ob-dim'>{row.model}</span>
                    </span>
                    <span className='lp-ob-cost'>
                        <span className='lp-ob-bar' aria-hidden='true'>
                            <i
                                style={{
                                    width: `${Math.round((row.costValue / dearest) * 100)}%`
                                }}
                            />
                        </span>
                        <b>{row.cost}</b>
                    </span>
                </div>
            ))}
            {/* Month to date belongs to cost, not to the section. */}
            <div className='lp-ob-foot'>
                <span>{t('web.landing.meterMonthToDate')}</span>
                <b>$12.40</b>
            </div>
        </div>,
        <div className='lp-ob-panel' key='control'>
            {PERMISSIONS.map(([verb, what, allowed]) => (
                <div className='lp-ob-perm' key={what}>
                    <span className='lp-ob-verb'>{verb}</span>
                    <span className='lp-ob-dim'>{what}</span>
                    <span
                        className={
                            allowed
                                ? 'lp-ob-tag lp-ob-yes'
                                : 'lp-ob-tag lp-ob-no'
                        }
                    >
                        {t(
                            allowed
                                ? 'web.landing.obsAllowed'
                                : 'web.landing.obsDenied'
                        )}
                    </span>
                </div>
            ))}
        </div>
    ]
    return (
        <section id='lp-metering' className='lp-section'>
            <div className='lp-container lp-ob'>
                <div className='lp-ob-head'>
                    <div className='lp-section-head'>
                        <div className='lp-eyebrow'>
                            {t('web.landing.obsEyebrow')}
                        </div>
                        <h2 className='lp-h2'>
                            {t('web.landing.obsTitle')}
                            {/* The break is explicit, the way the hero's is:
                                `balance` evens the lines out and drags the
                                accent's first word up to join the first. */}
                            <br />
                            <span className='lp-h-accent'>
                                {t('web.landing.obsTitleAccent')}
                            </span>
                        </h2>
                    </div>
                    <p className='lp-lead'>{t('web.landing.obsLead')}</p>
                </div>
                <div className='lp-ob-cols'>
                    {[1, 2, 3].map((n) => (
                        <div className='lp-ob-col' key={n}>
                            {panels[n - 1]}
                            <div className='lp-ob-claim'>
                                <b>{t(`web.landing.obsPoint${n}Label`)}</b>
                                <p>{t(`web.landing.obsPoint${n}Body`)}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    )
}

const PricingCard: FC<{
    tier: PricingTier
    billing: PricingBilling | null
}> = ({ tier, billing }): ReactNode => {
    const { t } = useI18n()
    const gate = useSignupGate()
    const name = TIER_LABEL[tier.id]
    const btnClass = 'lp-price-cta lp-btn lp-btn-primary'
    const ctaLabel =
        tier.price === 0
            ? t('web.landing.pricingCtaFree')
            : t('web.landing.pricingCtaPaid', { plan: name })

    // Signed-out: keep the existing gated sign-in lead flow.
    const signedOutCta =
        gate.loaded && gate.enabled ? (
            <button type='button' onClick={gate.open} className={btnClass}>
                {ctaLabel}
            </button>
        ) : (
            <Link to='/login' className={btnClass}>
                {ctaLabel}
            </Link>
        )

    // Signed-in: same three-state logic as the billing settings.
    const renderSignedInCta = (b: PricingBilling): ReactNode => {
        if (b.currentPlanId === tier.id) {
            return (
                <button
                    type='button'
                    disabled
                    className='lp-price-cta lp-btn lp-btn-secondary'
                >
                    {t('web.pricing.currentBadge')}
                </button>
            )
        }
        return (
            <button
                type='button'
                disabled={b.busy}
                onClick={() => b.onSelect(tier.id)}
                className={btnClass}
            >
                {b.isPaid
                    ? t('web.pricing.manageCta')
                    : t('web.pricing.subscribeCta')}
            </button>
        )
    }

    const cta = (
        <>
            <SignedOut>{signedOutCta}</SignedOut>
            <SignedIn>
                {billing ? (
                    renderSignedInCta(billing)
                ) : (
                    <Link
                        to='/workspace'
                        className='lp-price-cta lp-btn lp-btn-secondary'
                    >
                        {t('web.landing.openWorkspace')}
                    </Link>
                )}
            </SignedIn>
        </>
    )

    return (
        <article
            className={
                tier.popular ? 'lp-price-card lp-price-hot' : 'lp-price-card'
            }
        >
            <div className='lp-price-head'>
                <span className='lp-price-name'>{name}</span>
                {billing?.currentPlanId === tier.id ? (
                    <span className='lp-price-badge'>
                        {t('web.pricing.currentBadge')}
                    </span>
                ) : tier.popular ? (
                    <span className='lp-price-badge lp-price-popular'>
                        {t('web.landing.pricingPopular')}
                    </span>
                ) : null}
            </div>
            <p className='lp-price-tag'>{t(TIER_TAGLINE_KEY[tier.id])}</p>
            <div className='lp-price-amount'>
                {tier.price === 0 ? (
                    <span className='lp-price-num'>
                        {t('web.landing.pricingFree')}
                    </span>
                ) : (
                    <>
                        <span className='lp-price-num'>${tier.price}</span>
                        <span className='lp-price-per'>
                            {t('web.landing.pricingPerMonth')}
                        </span>
                    </>
                )}
            </div>
            {cta}
            <div className='lp-price-feats'>
                <ul>
                    <li className='lp-price-feat-star'>
                        <Sparkle aria-hidden='true' />
                        <span>
                            {tier.sandboxAgents}{' '}
                            {t('web.landing.pricingSandboxLabel')}
                        </span>
                    </li>
                    <li className='lp-price-feat-star'>
                        <Sparkle aria-hidden='true' />
                        <span>
                            {tier.alwaysOnlineAgents}{' '}
                            {t('web.landing.pricingAlwaysOnlineLabel')}
                        </span>
                    </li>
                    {tier.featureKeys.map((key) => (
                        <li key={key}>
                            <Check aria-hidden='true' />
                            <span>{t(key)}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </article>
    )
}

// Signed-in visitors get their live plan so the cards can mirror the
// Settings three-state CTA. Signed-out visitors never touch billing —
// the hook returns null and the cards keep the gated sign-in flow.
const Pricing: FC = (): ReactNode => {
    const { t } = useI18n()
    const { billing, actionError } = useSignedInBilling()
    return (
        <section id='lp-pricing' className='lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.landing.pricingEyebrow')}
                    </div>
                    <h2 className='lp-h2'>
                        {t('web.landing.pricingTitleBefore')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.pricingTitleAccent')}
                        </span>
                    </h2>
                    <p className='lp-lead'>{t('web.landing.pricingLead')}</p>
                </div>
                {actionError ? (
                    <p className='lp-price-error'>{actionError}</p>
                ) : null}
                <div className='lp-price-grid'>
                    {PRICING_TIERS.map((tier) => (
                        <PricingCard
                            key={tier.id}
                            tier={tier}
                            billing={billing}
                        />
                    ))}
                </div>
                <p className='lp-price-note'>{t('web.landing.pricingNote')}</p>
            </div>
        </section>
    )
}

const Faq: FC = (): ReactNode => {
    const { t } = useI18n()
    const [open, setOpen] = useState<number>(0)
    return (
        <section id='lp-faq' className='lp-section'>
            <div className='lp-container'>
                <div className='lp-faq-grid'>
                    <div className='lp-faq-side'>
                        <div className='lp-eyebrow'>
                            {t('web.landing.faqEyebrow')}
                        </div>
                        <h2 className='lp-h2'>
                            {t('web.landing.faqTitleBefore')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.faqTitleAccent')}
                            </span>
                        </h2>
                        <p className='lp-lead'>{t('web.landing.faqLead')}</p>
                    </div>
                    <div className='lp-faq-list'>
                        {FAQ_KEYS.map((item, index) => {
                            const isOpen = open === index
                            return (
                                <div
                                    key={item.q}
                                    className={`lp-faq-item ${isOpen ? 'lp-open' : ''}`}
                                >
                                    <button
                                        type='button'
                                        className='lp-faq-q'
                                        aria-expanded={isOpen}
                                        onClick={() =>
                                            setOpen(isOpen ? -1 : index)
                                        }
                                    >
                                        <span className='lp-qx'>
                                            {t(item.q)}
                                        </span>
                                        <Plus className='lp-ix' />
                                    </button>
                                    <div className='lp-faq-a'>{t(item.a)}</div>
                                </div>
                            )
                        })}
                    </div>
                </div>
            </div>
        </section>
    )
}

// The one CTA pair the hero scenes reuse: the gated sign-up flow when
// signed out, a straight route into the workspace when signed in.
const HeroCta: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <>
            <SignedOut>
                <SignedOutCtas />
            </SignedOut>
            <SignedIn>
                <Link to='/workspace' className='lp-btn lp-btn-primary'>
                    {t('web.landing.openWorkspace')}
                    <ArrowRight className='lp-arr' />
                </Link>
            </SignedIn>
        </>
    )
}

const Landing: FC = (): ReactNode => {
    const auth = useAppAuth()
    const [params] = useSearchParams()
    const { pathname, hash } = useLocation()
    const stay = params.get('stay') === '1'
    const zh = pathname === '/zh' || pathname.startsWith('/zh/')
    useMarketingLanguagePin()
    const signupGateFeature = useSignupGateFeature()
    const [gateFormOpen, setGateFormOpen] = useState(false)
    const [gateOpen, setGateOpen] = useState(false)
    const openGateForm = useCallback(() => {
        setGateOpen(false)
        setGateFormOpen(true)
    }, [])
    const closeGateForm = useCallback(() => setGateFormOpen(false), [])
    const openGate = useCallback(() => setGateOpen(true), [])
    const closeGate = useCallback(() => setGateOpen(false), [])

    /* The browser resolves a hash target once, while parsing the document —
       and this page is client-rendered, so at that moment #lp-pricing does not
       exist yet. It gives up and never retries, which left anyone arriving at
       /#lp-pricing (the nav's Pricing entry from another page, or a shared
       link) sitting at the top of the page with the section present but never
       scrolled to. Re-resolve it here, once the section is mounted. */
    useEffect(() => {
        const id = hash.slice(1)
        if (!id) return
        const target = document.getElementById(id)
        if (!target) return
        target.scrollIntoView()
    }, [hash])

    if (auth.isLoaded && auth.isSignedIn && !stay) {
        return <Navigate to='/workspace' replace />
    }

    return (
        <SignupGateContext.Provider
            value={{
                open: openGateForm,
                openGate,
                loaded: signupGateFeature.loaded,
                enabled: signupGateFeature.enabled
            }}
        >
            <div className='landing-root'>
                <div className='lp-z'>
                    <MarketingNav
                        badge={<LandingBrandBadge />}
                        overflowCta={(close) => (
                            <LandingOverflowCta close={close} />
                        )}
                        languagePaths={{ en: '/', zh: '/zh/' }}
                        homeTo={zh ? '/zh/' : '/'}
                        /* Bare hash: the section is on this page, so the
                           click should scroll rather than route. */
                        pricingTo='#lp-pricing'
                    />
                    <main>
                        <ScrollyStage cta={<HeroCta />} />
                        <WorksWith />
                        <Observability />
                        <Pricing />
                        <Faq />
                    </main>
                    <MarketingFooter badge={<LandingBrandBadge />} />
                </div>
                {signupGateFeature.enabled ? (
                    <>
                        <AccessGateModal
                            open={gateOpen}
                            onClose={closeGate}
                            onRequestAccess={openGateForm}
                        />
                        <SignupGateModal
                            open={gateFormOpen}
                            onClose={closeGateForm}
                        />
                    </>
                ) : null}
            </div>
        </SignupGateContext.Provider>
    )
}

export default Landing
