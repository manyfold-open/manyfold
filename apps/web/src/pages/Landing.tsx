import type { FC, ReactNode } from 'react'
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState
} from 'react'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import { ArrowRight, Check, Plus, Sparkle } from 'lucide-react'
import { ScrollyStage } from '@/components/landing/ScrollyStage'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import SignupGateModal from '@/components/signup-gate/SignupGateModal'
import AccessGateModal from '@/components/signup-gate/AccessGateModal'
import { useSignupGateFeature } from '@/components/signup-gate/useSignupGate'
import { useSignedInBilling, type PricingBilling } from '@/lib/landingBilling'
import { SignedIn, SignedOut, useAppAuth } from '@/lib/auth'
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
                            <div className='lp-ww-v'>
                                {row.chips.map((chip) => (
                                    <span
                                        key={chip.name ?? chip.key}
                                        className={
                                            chip.soft
                                                ? 'lp-chip lp-chip-soft'
                                                : 'lp-chip'
                                        }
                                    >
                                        {chip.name ?? t(chip.key ?? '')}
                                    </span>
                                ))}
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
    ownKey?: boolean
}> = [
    {
        turn: '#142',
        agent: 'cc-review',
        model: 'claude-sonnet-5',
        tokens: '38.2k',
        latency: '3.2s',
        cost: '$0.120'
    },
    {
        turn: '#141',
        agent: 'pr-bot',
        model: 'gpt-5-codex',
        tokens: '8.1k',
        latency: '2.1s',
        cost: '$0.052'
    },
    {
        turn: '#140',
        agent: 'research-mate',
        model: 'gemini-2.5-pro',
        tokens: '21.4k',
        latency: '4.8s',
        cost: '$0.011'
    },
    {
        turn: '#139',
        agent: 'cc-review',
        model: 'sonnet-5',
        tokens: '12.4k',
        latency: '2.9s',
        cost: '$0.084',
        ownKey: true
    }
]

const Metering: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-metering' className='lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.landing.meterEyebrow')}
                    </div>
                </div>
                <div className='lp-meter'>
                    <div className='lp-usage'>
                        <table>
                            <thead>
                                <tr>
                                    <th>{t('web.landing.meterColTurn')}</th>
                                    <th>{t('web.landing.meterColAgent')}</th>
                                    <th>{t('web.landing.meterColModel')}</th>
                                    <th>{t('web.landing.meterColTokens')}</th>
                                    <th>{t('web.landing.meterColLatency')}</th>
                                    <th>{t('web.landing.meterColCost')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {USAGE_ROWS.map((row) => (
                                    <tr key={row.turn}>
                                        <td>{row.turn}</td>
                                        <td className='lp-usage-strong'>
                                            {row.agent}
                                        </td>
                                        <td>
                                            {row.ownKey
                                                ? `${row.model} · ${t('web.landing.meterOwnKey')}`
                                                : row.model}
                                        </td>
                                        <td>{row.tokens}</td>
                                        <td>{row.latency}</td>
                                        <td className='lp-usage-strong'>
                                            {row.cost}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <div className='lp-usage-foot'>
                            <span>
                                {t('web.landing.meterMonthToDate')} ·{' '}
                                <b>$12.40</b>
                            </span>
                            <span>
                                {t('web.landing.meterProviderBalance')} ·{' '}
                                <b>$41.20</b>
                            </span>
                        </div>
                    </div>
                    <div>
                        <h2 className='lp-h2'>
                            {t('web.landing.meterTitle')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.meterTitleAccent')}
                            </span>
                        </h2>
                        <div className='lp-meter-points'>
                            {[1, 2, 3].map((n) => (
                                <p key={n} className='lp-meter-point'>
                                    <i aria-hidden='true' />
                                    <span>
                                        <b>
                                            {t(
                                                `web.landing.meterPoint${n}Label`
                                            )}
                                        </b>{' '}
                                        {t(`web.landing.meterPoint${n}Body`)}
                                    </span>
                                </p>
                            ))}
                        </div>
                        <p className='lp-meter-honest'>
                            {t('web.landing.meterHonest')}
                        </p>
                    </div>
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
const CtaSection: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section className='lp-cta'>
            <div className='lp-container'>
                <div className='lp-cta-card'>
                    <div className='lp-cta-inner'>
                        <h2>
                            {t('web.landing.ctaTitle1')}
                            <br />
                            {t('web.landing.ctaTitle2')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.ctaTitleAccent')}
                            </span>
                        </h2>
                        <p className='lp-cta-lead'>
                            {t('web.landing.ctaLead')}
                        </p>
                        <div className='lp-cta-ctas'>
                            <SignedOut>
                                <SignedOutCtas />
                            </SignedOut>
                            <SignedIn>
                                <Link
                                    to='/workspace'
                                    className='lp-btn lp-btn-primary'
                                >
                                    {t('web.landing.openWorkspace')}
                                    <ArrowRight className='lp-arr' />
                                </Link>
                            </SignedIn>
                        </div>
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
                        <Metering />
                        <Pricing />
                        <Faq />
                        <CtaSection />
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
