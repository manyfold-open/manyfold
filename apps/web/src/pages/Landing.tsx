import type {
    AgentFramework
} from '@manyfold/shared'
import type { FC, ReactNode } from 'react'
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import {
    ClaudeCodeColor,
    CodexColor,
    DifyColor,
    GeminiCLIColor,
    HermesAgentMono,
    OpenClawColor,
    type IconType
} from '@/lib/brandIcons'
import { FrameworkLogo } from '@/lib/frameworkMeta'
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom'
import {
    ArrowRight,
    Check,
    Cloud,
    Database,
    MessageSquare,
    Plus,
    Server,
    Sparkle,
    Sparkles,
    Workflow,
    Wrench
} from 'lucide-react'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import {
    ProductDemo,
    useProductDemoTilt
} from '@/components/marketing/ProductDemo'
import ShortcutTooltip from '@/components/ShortcutTooltip'
import SignupGateModal from '@/components/signup-gate/SignupGateModal'
import AccessGateModal from '@/components/signup-gate/AccessGateModal'
import { useSignupGateFeature } from '@/components/signup-gate/useSignupGate'
import {
    useSignedInBilling,
    type PricingBilling
} from '@/lib/landingBilling'
import { SignedIn, SignedOut, useAppAuth } from '@/lib/auth'
import { ChannelProviderIcon } from '@/lib/channelMeta'
import { useI18n } from '@/lib/i18n'
import {
    FAQ_KEYS,
    PRICING_TIERS,
    TIER_LABEL,
    TIER_TAGLINE_KEY,
    type PricingTier
} from '@/seo/landingContent'
import { useMarketingLanguagePin } from '@/seo/useMarketingLanguagePin'
import BrandBetaBadge from '@/components/signup-gate/BrandBetaBadge'
import GateCtaLabel from '@/components/signup-gate/CtaLabel'

type BrandIcon = IconType

const claudeCodeIcon: BrandIcon = ClaudeCodeColor
const codexIcon: BrandIcon = CodexColor
const geminiCliIcon: BrandIcon = GeminiCLIColor
const hermesAgentIcon: BrandIcon = HermesAgentMono
const openClawIcon: BrandIcon = OpenClawColor
const difyIcon: BrandIcon = DifyColor

type FloorBrand =
    | { name: string; icon: BrandIcon }
    | { name: string; framework: AgentFramework }

const FLOOR_BRANDS: FloorBrand[] = [
    { name: 'Claude Code', icon: claudeCodeIcon },
    { name: 'Codex', icon: codexIcon },
    { name: 'Gemini CLI', icon: geminiCliIcon },
    { name: 'NarraNexus', framework: 'narranexus' },
    { name: 'Dify', icon: difyIcon },
    { name: 'Langflow', framework: 'langflow' },
    { name: 'Hermes', icon: hermesAgentIcon },
    { name: 'Openclaw', icon: openClawIcon }
]

// Sized by the landing CSS (`.lp-* svg` rules), which carries the
// responsive breakpoints — no size prop so there is one source of truth.
const BrandAvatar: FC<{ icon: BrandIcon }> = ({ icon: Icon }) => (
    <Icon aria-hidden='true' />
)

// Supported-agents strip. Rendered inside the hero footbar on desktop and as a
// standalone block below the hero on phones (so it never squeezes the floor).
const FloorBrands: FC<{ className?: string }> = ({ className }) => {
    const { t } = useI18n()
    return (
        <div
            className={['lp-floor-brands', className].filter(Boolean).join(' ')}
        >
            <span className='lp-floor-brands-label'>
                {t('web.landing.heroFloorBrands')}
            </span>
            {FLOOR_BRANDS.map((brand) => (
                <span className='lp-floor-brand' key={brand.name}>
                    <span className='lp-floor-brand-ico'>
                        {'framework' in brand ? (
                            <FrameworkLogo
                                framework={brand.framework}
                                size={15}
                            />
                        ) : (
                            <BrandAvatar icon={brand.icon} />
                        )}
                    </span>
                    {brand.name}
                </span>
            ))}
        </div>
    )
}

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

const useSignupGate = (): SignupGateContextValue => useContext(SignupGateContext)

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
    return (
        <StepCtas
            onRequestAccess={gate.open}
            onSignIn={gate.openGate}
        />
    )
}

const LandingBrandBadge: FC = (): ReactNode => {
    const gate = useSignupGate()
    if (!gate.enabled) return null
    return (
        <BrandBetaBadge />
    )
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
                        <span><GateCtaLabel /></span>
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

const Hero: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section className='lp-hero'>
            <div className='lp-container'>
                <div className='lp-hero-content'>
                    <span className='lp-eyebrow lp-hero-eyebrow'>
                        <span className='lp-dot' />
                        <span>{t('web.landing.heroEyebrow')}</span>
                    </span>
                    <h1 className='lp-h1'>
                        {t('web.landing.heroTitleBefore')}{' '}
                        {t('web.landing.heroTitleAfter')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.heroTitleAccent')}
                        </span>
                    </h1>
                    <p className='lp-lead'>{t('web.landing.heroTagline')}</p>
                    <div className='lp-hero-ctas'>
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
                <div className='lp-product-demo-tilt'>
                    <ProductDemo />
                </div>
            </div>
        </section>
    )
}

// ── New "workspace floor" hero ────────────────────────────────────────
// A 3D perspective floor where agent standees roam between waypoints,
// and glowing framework cabinets line the back wall. Ported from the v3
// design and re-themed onto the landing --lp-* token system (blue accent,
// light + dark).

// The hero's size control wears a dog-eared page corner, not a chevron. A
// chevron would be legitimate — §8.10 allows one on a button whose verb already
// carries the direction — but it is also the most generic mark in the product,
// spent on the one control that is about the page itself. Mark and label share
// the folding metaphor instead (`Fold` / `Unfold`), which is why the same corner
// serves both states: it is the gesture, not a direction indicator, and the verb
// beside it is what says which way this press goes.
const FoldCornerIcon: FC = (): ReactNode => (
    <svg
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth={1.7}
        strokeLinecap='round'
        strokeLinejoin='round'
        aria-hidden='true'
    >
        <path d='M4 4h10l6 6v10z' />
        <path d='M14 4v6h6' />
    </svg>
)

interface FloorBot {
    id: string
    name: string
    framework: string
    icon?: BrandIcon
    iconFramework?: AgentFramework
    x: number
    y: number
    working?: boolean
}

// Floor-plane coordinate space (matches .lp-fl-plane width/height).
const FLOOR_W = 1600
const FLOOR_H = 1180

const FLOOR_BOTS: FloorBot[] = [
    {
        id: 'b1',
        name: 'refactor-bot',
        framework: 'Claude Code',
        icon: claudeCodeIcon,
        x: 720,
        y: 880
    },
    {
        id: 'b2',
        name: 'pr-reviewer',
        framework: 'Codex',
        icon: codexIcon,
        x: 980,
        y: 800
    },
    {
        id: 'b3',
        name: 'research-mate',
        framework: 'Gemini CLI',
        icon: geminiCliIcon,
        x: 420,
        y: 940
    },
    {
        id: 'b4',
        name: 'data-digger',
        framework: 'Openclaw',
        icon: openClawIcon,
        x: 1180,
        y: 940
    },
    {
        id: 'b5',
        name: 'ops-runner',
        framework: 'Hermes',
        icon: hermesAgentIcon,
        x: 600,
        y: 660
    },
    {
        id: 'b6',
        name: 'doc-writer',
        framework: 'NarraNexus',
        iconFramework: 'narranexus',
        x: 1140,
        y: 720
    }
]

const FLOOR_WAYPOINTS: ReadonlyArray<{ x: number; y: number }> = [
    { x: 360, y: 760 },
    { x: 540, y: 950 },
    { x: 760, y: 700 },
    { x: 700, y: 1000 },
    { x: 980, y: 880 },
    { x: 1140, y: 740 },
    { x: 1220, y: 1000 },
    { x: 460, y: 1020 }
]

interface FloorCabinet {
    id: string
    label: string
    icon: BrandIcon
    x: number
    // Cabinets are the same size; they step down via increasing y (depth),
    // so each sits a little further forward — a descending diagonal.
    y: number
    delay: string
}

const FLOOR_CABINETS: FloorCabinet[] = [
    {
        id: 'c1',
        label: 'Claude Code',
        icon: claudeCodeIcon,
        x: 950,
        y: 250,
        delay: '0s'
    },
    {
        id: 'c2',
        label: 'Codex',
        icon: codexIcon,
        x: 1100,
        y: 290,
        delay: '0.6s'
    },
    {
        id: 'c3',
        label: 'Gemini CLI',
        icon: geminiCliIcon,
        x: 1250,
        y: 330,
        delay: '1.2s'
    },
    {
        id: 'c4',
        label: 'Hermes',
        icon: hermesAgentIcon,
        x: 1400,
        y: 370,
        delay: '1.8s'
    }
]

// `working` is dynamic: true while the agent stands on a workbench. It drives
// the amber LED, the in-place bob, the lift onto the slab, and planted legs.
const FloorBotStandee: FC<{
    bot: FloorBot
    pos: { x: number; y: number }
    selected: boolean
    moving: boolean
    working?: boolean
    receiving?: boolean
    onSelect: () => void
}> = ({
    bot,
    pos,
    selected,
    moving,
    working,
    receiving,
    onSelect
}): ReactNode => {
    const Icon = bot.icon
    return (
        <div
            className='lp-fl-bot'
            style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            data-working={working ? 'true' : 'false'}
            data-selected={selected ? 'true' : 'false'}
            data-moving={moving ? 'true' : 'false'}
            data-receiving={receiving ? 'true' : 'false'}
        >
            <span className='lp-fl-bot-shadow' />
            <button
                type='button'
                className='lp-fl-bot-standee'
                onClick={onSelect}
                tabIndex={-1}
                aria-label={`${bot.name} · ${bot.framework}`}
            >
                <span className='lp-fl-bot-plate'>
                    <span className='lp-fl-bot-name'>{bot.name}</span>
                    <span className='lp-fl-bot-fw'>{bot.framework}</span>
                </span>
                <span className='lp-fl-bot-neck' />
                <span className='lp-fl-bot-led' />
                <span className='lp-fl-bot-head'>
                    <span className='lp-fl-bot-face'>
                        {bot.iconFramework ? (
                            <FrameworkLogo
                                framework={bot.iconFramework}
                                size={22}
                            />
                        ) : Icon ? (
                            <Icon aria-hidden='true' />
                        ) : null}
                    </span>
                    <span className='lp-fl-bot-corner' />
                </span>
                <span className='lp-fl-bot-body'>
                    <span className='lp-fl-bot-stripe' />
                </span>
                <span className='lp-fl-bot-legs'>
                    <span className='lp-fl-bot-leg lp-fl-bot-leg-a' />
                    <span className='lp-fl-bot-leg lp-fl-bot-leg-b' />
                </span>
            </button>
        </div>
    )
}

// A workbench is an empty raised platform (its surface matches the page
// background). Agents walk onto a free one to work, then step back down — the
// agent standees are rendered separately and positioned onto the pad.
const FloorPad: FC<{ x: number; y: number }> = ({ x, y }): ReactNode => (
    <div className='lp-fl-pad' style={{ left: `${x}px`, top: `${y}px` }}>
        <span className='lp-fl-pad-glow' />
        <span className='lp-fl-pad-slab'>
            <span className='lp-fl-pad-scan' />
        </span>
    </div>
)

const FloorCabinetCase: FC<{ cabinet: FloorCabinet }> = ({
    cabinet
}): ReactNode => {
    const Icon = cabinet.icon
    return (
        <div
            className='lp-fl-cab'
            style={{ left: `${cabinet.x}px`, top: `${cabinet.y}px` }}
        >
            <span className='lp-fl-cab-ring' />
            <div className='lp-fl-cab-stand'>
                <span className='lp-fl-cab-tag'>
                    <span className='lp-fl-cab-tag-dot' />
                    <span>{cabinet.label}</span>
                </span>
                <span
                    className='lp-fl-cab-case'
                    style={{ animationDelay: cabinet.delay }}
                >
                    <span className='lp-fl-cab-rail lp-fl-cab-rail-l' />
                    <span className='lp-fl-cab-rail lp-fl-cab-rail-r' />
                    <span
                        className='lp-fl-cab-scan'
                        style={{ animationDelay: cabinet.delay }}
                    />
                    <span className='lp-fl-cab-icon'>
                        <Icon aria-hidden='true' />
                    </span>
                    <span className='lp-fl-cab-top' />
                </span>
                <span className='lp-fl-cab-base' />
            </div>
        </div>
    )
}

// Selecting a floor bot surfaces a "claim & create" affordance, mirroring
// the design: a chip naming the picked agent + framework, then a create
// CTA that drops into the real new-agent flow (or the gated sign-in
// flow for signed-out visitors).
const FloorSelectCta: FC<{ bot: FloorBot }> = ({ bot }): ReactNode => {
    const { t } = useI18n()
    const gate = useSignupGate()
    const Icon = bot.icon
    const label = (
        <>
            {t('web.landing.heroCreateCta')}
            <ArrowRight className='lp-arr' />
        </>
    )
    return (
        <div className='lp-floor-select'>
            <span className='lp-floor-select-chip'>
                <span className='lp-floor-select-icon'>
                    {bot.iconFramework ? (
                        <FrameworkLogo
                            framework={bot.iconFramework}
                            size={15}
                        />
                    ) : Icon ? (
                        <Icon aria-hidden='true' />
                    ) : null}
                </span>
                <span className='lp-floor-select-name'>{bot.name}</span>
                <span className='lp-floor-select-fw'>{bot.framework}</span>
            </span>
            <SignedIn>
                <Link
                    to='/agents/new'
                    className='lp-btn lp-btn-primary lp-floor-create'
                >
                    {label}
                </Link>
            </SignedIn>
            <SignedOut>
                {gate.loaded && gate.enabled ? (
                    <button
                        type='button'
                        className='lp-btn lp-btn-primary lp-floor-create'
                        onClick={gate.open}
                    >
                        {label}
                    </button>
                ) : (
                    <Link
                        to='/login'
                        className='lp-btn lp-btn-primary lp-floor-create'
                    >
                        {label}
                    </Link>
                )}
            </SignedOut>
        </div>
    )
}

const ROAM_INTERVAL_MS = 4200

// Responsive density. The floor is a fixed-size px stage, so on narrow
// viewports we don't scale it down (that crushes the bots) — instead we show
// fewer elements and keep every kept element inside a centred, fully-visible
// band so nothing is clipped or perspective-skewed at the edges.
//   wide   (≥1180): roamers + 2 workbenches; cabinets when ≥1360
//   mid    (700–1179): roamers + 1 workbench, no cabinets
//   narrow (<700): static roamers + 1 workbench, no roaming/cabinets
// Roamers walk between waypoints (legs animate while in transit). Stations
// hold a working agent that bobs in place. Hand-offs happen when two roamers
// meet: they pause to exchange, then carry on (mid + wide, where roaming is
// live).
type FloorTier = 'wide' | 'mid' | 'narrow'

const TIER_BOT_IDS: Record<FloorTier, string[]> = {
    wide: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'],
    mid: ['b1', 'b2', 'b3', 'b5'],
    narrow: ['b1', 'b2', 'b5']
}

// Workbench placements per tier (the pad's plane coordinate).
interface StationPlacement {
    id: string
    x: number
    y: number
}
const TIER_STATIONS: Record<FloorTier, StationPlacement[]> = {
    wide: [
        { id: 's1', x: 600, y: 660 },
        { id: 's2', x: 1140, y: 720 }
    ],
    mid: [{ id: 's1', x: 800, y: 660 }],
    narrow: [{ id: 's1', x: 800, y: 740 }]
}

// Which agent starts on which bench (agentId → stationId). On mid/wide agents
// then cycle on and off; on narrow (no roaming) the arrangement stays put.
const TIER_INITIAL_ASSIGN: Record<FloorTier, Record<string, string>> = {
    wide: { b5: 's1', b6: 's2' },
    mid: { b5: 's1' },
    narrow: { b5: 's1' }
}

// Roam start positions for the agents that don't start on a bench.
const TIER_INITIAL: Record<
    FloorTier,
    Record<string, { x: number; y: number }>
> = {
    wide: {
        b1: { x: 760, y: 900 },
        b2: { x: 980, y: 820 },
        b3: { x: 420, y: 940 },
        b4: { x: 1180, y: 960 }
    },
    mid: {
        b1: { x: 800, y: 990 },
        b2: { x: 600, y: 880 },
        b3: { x: 1000, y: 880 }
    },
    narrow: {
        b1: { x: 710, y: 985 },
        b2: { x: 890, y: 985 }
    }
}

const TIER_WAYPOINTS: Record<
    FloorTier,
    ReadonlyArray<{ x: number; y: number }>
> = {
    wide: FLOOR_WAYPOINTS,
    mid: [
        { x: 560, y: 760 },
        { x: 760, y: 980 },
        { x: 1020, y: 800 },
        { x: 840, y: 1000 },
        { x: 600, y: 960 },
        { x: 980, y: 920 }
    ],
    narrow: []
}

const getFloorTier = (w: number): FloorTier =>
    w < 700 ? 'narrow' : w < 1180 ? 'mid' : 'wide'

// Keep roaming/hand-off targets off the workbench footprints — only the agent
// assigned to a bench steps onto it. If a target lands on a pad, push it
// forward (toward the viewer) onto open floor.
const STATION_AVOID_X = 135
const STATION_AVOID_Y = 115
const offStations = (
    pt: { x: number; y: number },
    stations: ReadonlyArray<StationPlacement>
): { x: number; y: number } => {
    const { x } = pt
    let { y } = pt
    for (const s of stations) {
        if (
            Math.abs(x - s.x) < STATION_AVOID_X &&
            Math.abs(y - s.y) < STATION_AVOID_Y
        ) {
            y = s.y + STATION_AVOID_Y + 24
        }
    }
    return { x, y }
}

interface FloorSeed {
    positions: Record<string, { x: number; y: number }>
    assign: Record<string, string | null>
}

// Initial positions + bench assignments for a tier. Agents that start on a
// bench are placed at the pad; the rest sit at their roam start.
const tierSeed = (tier: FloorTier): FloorSeed => {
    const assignInit = TIER_INITIAL_ASSIGN[tier]
    const positions: Record<string, { x: number; y: number }> = {}
    const assign: Record<string, string | null> = {}
    TIER_BOT_IDS[tier].forEach((id) => {
        const stationId = assignInit[id] ?? null
        assign[id] = stationId
        if (stationId) {
            const s = TIER_STATIONS[tier].find((p) => p.id === stationId)
            positions[id] = s ? { x: s.x, y: s.y } : { x: 800, y: 900 }
        } else {
            positions[id] = { ...TIER_INITIAL[tier][id] }
        }
    })
    return { positions, assign }
}

const FloorHero: FC<{ onFold: () => void }> = ({ onFold }): ReactNode => {
    const { t } = useI18n()
    const [vw, setVw] = useState<number>(() =>
        typeof window !== 'undefined' ? window.innerWidth : 1280
    )
    const tier = getFloorTier(vw)
    const showCabinets = vw >= 1360
    const visibleBots = useMemo(
        () => FLOOR_BOTS.filter((bot) => TIER_BOT_IDS[tier].includes(bot.id)),
        [tier]
    )
    const stations = TIER_STATIONS[tier]

    const [seed] = useState(() => tierSeed(getFloorTier(vw)))
    const [positions, setPositions] = useState(() => seed.positions)
    // agentId → the bench it is working at, or null while roaming.
    const [assign, setAssign] = useState<Record<string, string | null>>(
        () => seed.assign
    )
    const [selected, setSelected] = useState<string | null>(null)
    // Bots whose legs should be stepping — only those mid-transition. Anyone
    // standing still (bench workers, idle roamers) keeps their legs planted.
    const [movingIds, setMovingIds] = useState<ReadonlyArray<string>>([])
    // A hand-off happens when two roaming agents meet: they walk to a shared
    // point ('approach'), pause there to hand off ('handoff'), then resume
    // roaming. `x`/`y` is the meeting spot (where the ⇄ badge sits).
    const [meeting, setMeeting] = useState<{
        a: string
        b: string
        x: number
        y: number
        phase: 'approach' | 'handoff'
    } | null>(null)
    const selectedRef = useRef<string | null>(null)
    selectedRef.current = selected
    const meetingRef = useRef<typeof meeting>(null)
    meetingRef.current = meeting
    const assignRef = useRef(assign)
    assignRef.current = assign

    useEffect(() => {
        const onResize = (): void => setVw(window.innerWidth)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    // Re-seat the bots whenever the tier changes, reset transient motion, and
    // drop a selection that belongs to a now-hidden agent.
    useEffect(() => {
        const next = tierSeed(tier)
        setPositions(next.positions)
        setAssign(next.assign)
        setMovingIds([])
        setMeeting(null)
        if (
            selectedRef.current &&
            !TIER_BOT_IDS[tier].includes(selectedRef.current)
        ) {
            setSelected(null)
        }
    }, [tier])

    useEffect(() => {
        const waypoints = TIER_WAYPOINTS[tier]
        if (
            typeof window === 'undefined' ||
            waypoints.length === 0 ||
            window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
            return
        }
        const ids = TIER_BOT_IDS[tier]
        const tierStations = TIER_STATIONS[tier]
        let used = 0
        let clearTimer = 0
        const markMoving = (movers: ReadonlyArray<string>): void => {
            if (movers.length === 0) return
            setMovingIds(movers)
            window.clearTimeout(clearTimer)
            // Stop the legs once the position transition has finished.
            clearTimer = window.setTimeout(() => setMovingIds([]), 3400)
        }
        const id = window.setInterval(() => {
            // Advance an in-flight hand-off first.
            const active = meetingRef.current
            if (active) {
                if (active.phase === 'approach') {
                    setMeeting({ ...active, phase: 'handoff' })
                    setMovingIds([])
                } else {
                    const wpA = offStations(
                        waypoints[used % waypoints.length],
                        tierStations
                    )
                    const wpB = offStations(
                        waypoints[(used + 1) % waypoints.length],
                        tierStations
                    )
                    used += 2
                    setPositions((cur) => ({
                        ...cur,
                        [active.a]: wpA,
                        [active.b]: wpB
                    }))
                    setMeeting(null)
                    markMoving([active.a, active.b])
                }
                return
            }

            const assignNow = assignRef.current
            const workers = ids.filter((b) => assignNow[b])
            const free = ids.filter(
                (b) => !assignNow[b] && b !== selectedRef.current
            )
            const takenStations = new Set(
                ids.map((b) => assignNow[b]).filter(Boolean) as string[]
            )
            const freeStations = tierStations.filter(
                (s) => !takenStations.has(s.id)
            )
            const roll = Math.random()

            // (A) A bench worker finishes and steps back down to roam.
            if (workers.length > 0 && roll < 0.3) {
                const w = workers[used % workers.length]
                used += 1
                const wp = offStations(
                    waypoints[used % waypoints.length],
                    tierStations
                )
                used += 1
                setAssign((cur) => ({ ...cur, [w]: null }))
                setPositions((cur) => ({ ...cur, [w]: wp }))
                markMoving([w])
                return
            }
            // (B) A roaming agent walks up onto a free bench to work.
            if (freeStations.length > 0 && free.length > 0 && roll < 0.6) {
                const s = freeStations[used % freeStations.length]
                const f = free[used % free.length]
                used += 1
                setAssign((cur) => ({ ...cur, [f]: s.id }))
                setPositions((cur) => ({ ...cur, [f]: { x: s.x, y: s.y } }))
                markMoving([f])
                return
            }
            // (C) Two roaming agents meet for a hand-off.
            if (free.length >= 2 && roll < 0.8) {
                const a = free[used % free.length]
                const b = free.find((x) => x !== a)
                const spot = offStations(
                    waypoints[used % waypoints.length],
                    tierStations
                )
                used += 1
                if (b) {
                    setPositions((cur) => ({
                        ...cur,
                        [a]: { x: spot.x - 48, y: spot.y },
                        [b]: { x: spot.x + 48, y: spot.y }
                    }))
                    setMeeting({
                        a,
                        b,
                        x: spot.x,
                        y: spot.y,
                        phase: 'approach'
                    })
                    markMoving([a, b])
                    return
                }
            }
            // (D) Ordinary roaming for the free agents.
            const updates: Record<string, { x: number; y: number }> = {}
            const moved: string[] = []
            free.forEach((botId, index) => {
                if (Math.random() < 0.45) return
                const wp = waypoints[(used + index) % waypoints.length]
                updates[botId] = offStations(
                    {
                        x: wp.x + (index % 2 === 0 ? 20 : -20),
                        y: wp.y + (index % 3 === 0 ? 16 : -10)
                    },
                    tierStations
                )
                moved.push(botId)
            })
            used += 3
            if (moved.length > 0) {
                setPositions((cur) => ({ ...cur, ...updates }))
                markMoving(moved)
            }
        }, ROAM_INTERVAL_MS)
        return () => {
            window.clearInterval(id)
            window.clearTimeout(clearTimer)
        }
    }, [tier])

    const selectedBot = visibleBots.find((bot) => bot.id === selected) ?? null

    const toggleSelect = (id: string): void =>
        setSelected((prev) => (prev === id ? null : id))

    return (
        <section className='lp-floor'>
            <div className='lp-floor-stage' aria-hidden='true'>
                <div className='lp-floor-scene'>
                    <div
                        className='lp-fl-plane'
                        style={{
                            width: `${FLOOR_W}px`,
                            height: `${FLOOR_H}px`
                        }}
                    >
                        <span className='lp-fl-belt' />
                        {showCabinets
                            ? FLOOR_CABINETS.map((cabinet) => (
                                  <FloorCabinetCase
                                      key={cabinet.id}
                                      cabinet={cabinet}
                                  />
                              ))
                            : null}
                        {stations.map((placement) => (
                            <FloorPad
                                key={placement.id}
                                x={placement.x}
                                y={placement.y}
                            />
                        ))}
                        {meeting && meeting.phase === 'handoff' ? (
                            <div
                                className='lp-fl-handoff'
                                style={{
                                    left: `${meeting.x}px`,
                                    top: `${meeting.y - 18}px`
                                }}
                            >
                                {t('web.landing.handoff')}
                            </div>
                        ) : null}
                        {visibleBots.map((bot) => (
                            <FloorBotStandee
                                key={bot.id}
                                bot={bot}
                                pos={
                                    positions[bot.id] ?? { x: bot.x, y: bot.y }
                                }
                                selected={selected === bot.id}
                                moving={movingIds.includes(bot.id)}
                                working={assign[bot.id] != null}
                                receiving={
                                    meeting?.phase === 'handoff' &&
                                    (meeting.a === bot.id ||
                                        meeting.b === bot.id)
                                }
                                onSelect={() => toggleSelect(bot.id)}
                            />
                        ))}
                    </div>
                </div>
            </div>

            <div className='lp-floor-overlay'>
                <div className='lp-container lp-floor-overlay-inner'>
                    <div className='lp-floor-copy'>
                        <span className='lp-eyebrow lp-floor-eyebrow'>
                            <span className='lp-dot' />
                            <span>{t('web.landing.heroEyebrow')}</span>
                        </span>
                        <h1 className='lp-floor-h1'>
                            {t('web.landing.heroTitleBefore')}
                            <br />
                            {t('web.landing.heroTitleAfter')}{' '}
                            <span className='lp-floor-accent'>
                                {t('web.landing.heroTitleAccent')}
                            </span>
                        </h1>
                        <p className='lp-floor-lead'>
                            {t('web.landing.heroTagline')}
                        </p>
                        <div className='lp-floor-ctas'>
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

            <div className='lp-floor-footbar'>
                <div className='lp-container'>
                    <div className='lp-floor-footbar-inner'>
                        <ShortcutTooltip
                            label={t('web.landing.heroFoldHint')}
                            placement='top'
                        >
                            <button
                                type='button'
                                className='lp-btn lp-btn-secondary lp-floor-fold'
                                onClick={onFold}
                            >
                                <FoldCornerIcon />
                                <span className='lp-floor-fold-label'>
                                    {t('web.landing.heroFoldCta')}
                                </span>
                            </button>
                        </ShortcutTooltip>
                        <div className='lp-floor-actions'>
                            <span className='lp-floor-claim'>
                                {t('web.landing.heroFloorClaim')}
                            </span>
                            {selectedBot ? (
                                <FloorSelectCta bot={selectedBot} />
                            ) : (
                                <span className='lp-floor-hint'>
                                    <span className='lp-floor-hint-mark'>
                                        ▷
                                    </span>
                                    {t('web.landing.heroClaimHint')}
                                </span>
                            )}
                        </div>
                    </div>
                    <FloorBrands />
                </div>
            </div>
        </section>
    )
}

const Machines: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-machines' className='lp-machines-bg lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <h2 className='lp-h2'>
                        {t('web.landing.machinesTitle1')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.machinesTitleAccent')}
                        </span>
                    </h2>
                    <p className='lp-lead'>{t('web.landing.machinesBody')}</p>
                </div>
                <div className='lp-machines-grid'>
                    <div className='lp-machine'>
                        <span className='lp-ico'>
                            <Cloud />
                        </span>
                        <div>
                            <div className='lp-nm'>
                                <span className='lp-h-accent'>
                                    {t('web.landing.machineCloudName1')}
                                </span>{' '}
                                {t('web.landing.machineCloudName2')}
                            </div>
                            <p className='lp-ds'>
                                {t('web.landing.machineCloudBody')}
                            </p>
                        </div>
                        <span className='lp-tag'>
                            {t('web.landing.machineCloudTag1')} ·{' '}
                            <span className='lp-v'>
                                {t('web.landing.machineCloudTag2')}
                            </span>
                        </span>
                    </div>
                    <div className='lp-machine'>
                        <span className='lp-ico'>
                            <Database />
                        </span>
                        <div>
                            <div className='lp-nm'>
                                <span className='lp-h-accent'>
                                    {t('web.landing.machineLocalName1')}
                                </span>{' '}
                                {t('web.landing.machineLocalName2')}
                            </div>
                            <p className='lp-ds'>
                                {t('web.landing.machineLocalBody')}
                            </p>
                        </div>
                        <span className='lp-tag'>
                            {t('web.landing.machineLocalTag1')} ·{' '}
                            <span className='lp-v'>
                                {t('web.landing.machineLocalTag2')}
                            </span>
                        </span>
                    </div>
                    <div className='lp-machine'>
                        <span className='lp-ico'>
                            <Server />
                        </span>
                        <div>
                            <div className='lp-nm'>
                                {t('web.landing.machineByoName1')}{' '}
                                <span className='lp-h-accent'>
                                    {t('web.landing.machineByoName2')}
                                </span>{' '}
                                {t('web.landing.machineByoName3')}
                            </div>
                            <p className='lp-ds'>
                                {t('web.landing.machineByoBody')}
                            </p>
                        </div>
                        <span className='lp-tag'>
                            {t('web.landing.machineByoTag1')} ·{' '}
                            <span className='lp-v'>
                                {t('web.landing.machineByoTag2')}
                            </span>
                        </span>
                    </div>
                </div>
            </div>
        </section>
    )
}

const Flow: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-flow' className='lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <h2 className='lp-h2'>
                        {t('web.landing.flowTitleBefore')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.flowTitleAccent')}
                        </span>
                    </h2>
                    <p className='lp-lead'>{t('web.landing.flowBody')}</p>
                </div>
                <div className='lp-flow'>
                    <div className='lp-step'>
                        <span className='lp-step-num'>01</span>
                        <h3 className='lp-h3'>
                            {t('web.landing.flowStep1Title1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.flowStep1TitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-step-body'>
                            {t('web.landing.flowStep1Body')}
                        </p>
                        <div className='lp-step-visual'>
                            <div className='lp-step-logos'>
                                <span className='lp-lg'>
                                    <BrandAvatar icon={claudeCodeIcon} />
                                </span>
                                <span className='lp-lg'>
                                    <BrandAvatar icon={codexIcon} />
                                </span>
                                <span className='lp-lg'>
                                    <BrandAvatar icon={geminiCliIcon} />
                                </span>
                                <span className='lp-lg'>
                                    <BrandAvatar icon={hermesAgentIcon} />
                                </span>
                                <span className='lp-lg'>
                                    <BrandAvatar icon={openClawIcon} />
                                </span>
                            </div>
                        </div>
                    </div>
                    <div className='lp-step'>
                        <span className='lp-step-num'>02</span>
                        <h3 className='lp-h3'>
                            {t('web.landing.flowStep2Title1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.flowStep2TitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-step-body'>
                            {t('web.landing.flowStep2Body')}
                        </p>
                        <div className='lp-step-visual'>
                            <div className='lp-step-host'>
                                <div className='lp-tile lp-cloud'>
                                    <div className='lp-h'>
                                        <Cloud />
                                        {t('web.landing.flowStep2TileCloud')}
                                    </div>
                                    <div className='lp-l'>
                                        {t('web.landing.flowStep2TileCloudTag')}
                                    </div>
                                </div>
                                <div className='lp-tile lp-local'>
                                    <div className='lp-h'>
                                        <Database />
                                        {t('web.landing.flowStep2TileLocal')}
                                    </div>
                                    <div className='lp-l'>
                                        {t('web.landing.flowStep2TileLocalTag')}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className='lp-step'>
                        <span className='lp-step-num'>03</span>
                        <h3 className='lp-h3'>
                            {t('web.landing.flowStep3Title1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.flowStep3TitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-step-body'>
                            {t('web.landing.flowStep3Body')}
                        </p>
                        <div className='lp-step-visual'>
                            <div className='lp-step-chat'>
                                <span className='lp-who'>
                                    {t('web.landing.flowStep3You')}
                                </span>
                                <span className='lp-text'>
                                    {t('web.landing.flowStep3Sample')}
                                    <span className='lp-caret' />
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    )
}

const Features: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-features' className='lp-features-bg lp-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <h2 className='lp-h2'>
                        {t('web.landing.featuresTitle1')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.landing.featuresTitleAccent')}
                        </span>{' '}
                        {t('web.landing.featuresTitle2')}
                    </h2>
                    <p className='lp-lead'>{t('web.landing.featuresBody')}</p>
                </div>
                <div className='lp-feat-grid'>
                    <article className='lp-feat'>
                        <span className='lp-ico'>
                            <Workflow />
                        </span>
                        <h3 className='lp-ttl'>
                            <span className='lp-h-accent'>
                                {t('web.landing.featAutomateTitleAccent')}
                            </span>{' '}
                            {t('web.landing.featAutomateTitleRest')}
                        </h3>
                        <p className='lp-ds'>
                            {t('web.landing.featAutomateBody')}
                        </p>
                        <div className='lp-vis'>
                            <div className='lp-auto-stages'>
                                <div className='lp-auto-stage'>
                                    <span className='lp-lbl'>
                                        {t('web.landing.featAutomateWhen')}
                                    </span>
                                    <span className='lp-v'>
                                        {t('web.landing.featAutomateWhenValue')}
                                    </span>
                                </div>
                                <span className='lp-auto-arr'>
                                    <ArrowRight />
                                </span>
                                <div className='lp-auto-stage'>
                                    <span className='lp-lbl'>
                                        {t('web.landing.featAutomateRun')}
                                    </span>
                                    <span className='lp-v'>cc-review</span>
                                </div>
                                <span className='lp-auto-arr'>
                                    <ArrowRight />
                                </span>
                                <div className='lp-auto-stage'>
                                    <span className='lp-lbl'>
                                        {t('web.landing.featAutomatePost')}
                                    </span>
                                    <span className='lp-v'>Lark</span>
                                </div>
                            </div>
                        </div>
                    </article>
                    <article className='lp-feat'>
                        <span className='lp-ico'>
                            <MessageSquare />
                        </span>
                        <h3 className='lp-ttl'>
                            {t('web.landing.featChannelsTitle1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.featChannelsTitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-ds'>
                            {t('web.landing.featChannelsBody')}
                        </p>
                        <div className='lp-vis'>
                            <div className='lp-int-chips'>
                                <span className='lp-int-chip'>
                                    <ChannelProviderIcon provider='lark' />
                                    Lark
                                </span>
                                <span className='lp-int-chip'>
                                    <ChannelProviderIcon provider='matrix' />
                                    Matrix
                                </span>
                                <span className='lp-int-chip'>
                                    <ChannelProviderIcon provider='slack' />
                                    Slack
                                </span>
                                <span className='lp-int-chip'>
                                    <ChannelProviderIcon provider='discord' />
                                    Discord
                                </span>
                                <span className='lp-int-chip'>
                                    <ChannelProviderIcon provider='telegram' />
                                    Telegram
                                </span>
                            </div>
                        </div>
                    </article>
                    <article className='lp-feat'>
                        <span className='lp-ico'>
                            <Sparkles />
                        </span>
                        <h3 className='lp-ttl'>
                            {t('web.landing.featThreadTitle1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.featThreadTitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-ds'>
                            {t('web.landing.featThreadBody')}
                        </p>
                        <div className='lp-vis'>
                            <div className='lp-thread'>
                                <div className='lp-thr-step'>
                                    <span className='lp-d'>
                                        <BrandAvatar icon={claudeCodeIcon} />
                                    </span>
                                    <span className='lp-tx'>
                                        <span className='lp-nm'>
                                            cc-refactor
                                        </span>{' '}
                                        ·{' '}
                                        {t('web.landing.featThreadStep1Suffix')}
                                    </span>
                                </div>
                                <div className='lp-thr-step'>
                                    <span className='lp-d'>
                                        <BrandAvatar icon={codexIcon} />
                                    </span>
                                    <span className='lp-tx'>
                                        <span className='lp-nm'>
                                            codex-review
                                        </span>{' '}
                                        ·{' '}
                                        {t('web.landing.featThreadStep2Suffix')}
                                    </span>
                                </div>
                                <div className='lp-thr-step'>
                                    <span className='lp-d'>
                                        <BrandAvatar icon={geminiCliIcon} />
                                    </span>
                                    <span className='lp-tx'>
                                        <span className='lp-nm'>
                                            gemini-research
                                        </span>{' '}
                                        ·{' '}
                                        {t('web.landing.featThreadStep3Suffix')}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </article>
                    <article className='lp-feat'>
                        <span className='lp-ico'>
                            <Wrench />
                        </span>
                        <h3 className='lp-ttl'>
                            {t('web.landing.featMcpTitle1')}{' '}
                            <span className='lp-h-accent'>
                                {t('web.landing.featMcpTitleAccent')}
                            </span>
                        </h3>
                        <p className='lp-ds'>{t('web.landing.featMcpBody')}</p>
                        <div className='lp-vis'>
                            <div className='lp-mcp-row'>
                                <span className='lp-d lp-run' />
                                <span className='lp-mn'>github-mcp</span>
                                <span className='lp-v'>
                                    {t('web.landing.featMcpRunning')}
                                </span>
                            </div>
                            <div className='lp-mcp-row'>
                                <span className='lp-d' />
                                <span className='lp-mn'>postgres-mcp</span>
                                <span className='lp-v'>
                                    {t('web.landing.featMcpReady')}
                                </span>
                            </div>
                            <div className='lp-mcp-row'>
                                <span className='lp-d' />
                                <span className='lp-mn'>slack-mcp</span>
                                <span className='lp-v'>
                                    {t('web.landing.featMcpReady')}
                                </span>
                            </div>
                        </div>
                    </article>
                </div>
            </div>
        </section>
    )
}

// Billing state shared with the signed-in CTA. Null while still loading
// (or unavailable for signed-out visitors), in which case the card falls
// back to the gated sign-in flow.
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
        <article className='lp-price-card'>
            <div className='lp-price-head'>
                <span className='lp-price-name'>{name}</span>
                {billing?.currentPlanId === tier.id ? (
                    <span className='lp-price-badge'>
                        {t('web.pricing.currentBadge')}
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

const setInert = (el: HTMLElement | null, on: boolean): void => {
    if (!el) return
    if (on) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
}

// Expanded / collapsed hero: the floor hero (front, expanded) turns away to
// reveal the compact classic hero (back). The stage height tracks whichever
// face is active so the sections below never jump while the card turns.
const HeroFold: FC<{ onClassicHeroMount?: () => void }> = ({
    onClassicHeroMount
}): ReactNode => {
    const { t } = useI18n()
    const [folded, setFolded] = useState(false)
    // The classic hero (plus ProductDemo) only mounts on the first fold: it
    // is invisible until then, and keeping it out of the initial render keeps
    // the landing DOM to a single H1 and drops its React/DOM cost from first
    // paint. The flip transition still animates — the rotating flip-inner
    // element exists from the start; only the back face content is late.
    const [backMounted, setBackMounted] = useState(false)
    const frontRef = useRef<HTMLDivElement | null>(null)
    const backRef = useRef<HTMLDivElement | null>(null)

    const fold = (): void => {
        setBackMounted(true)
        onClassicHeroMount?.()
        setFolded(true)
    }

    // The card height is viewport-driven in CSS (--fl-hero-h); here we only
    // keep the hidden face inert so it can't be tabbed into during the flip.
    useEffect(() => {
        setInert(frontRef.current, folded)
        setInert(backRef.current, !folded)
    }, [folded])

    return (
        <>
            <div
                className='lp-hero-flip'
                data-folded={folded ? 'true' : 'false'}
            >
                <div className='lp-hero-flip-inner'>
                    <div
                        className='lp-hero-face lp-hero-face-front'
                        ref={frontRef}
                    >
                        <FloorHero onFold={fold} />
                    </div>
                    <div
                        className='lp-hero-face lp-hero-face-back'
                        ref={backRef}
                    >
                        {backMounted ? (
                            <>
                                <Hero />
                                <div className='lp-floor-footbar lp-unfold-bar'>
                                    <div className='lp-container lp-floor-footbar-inner'>
                                        <ShortcutTooltip
                                            label={t(
                                                'web.landing.heroUnfoldHint'
                                            )}
                                            placement='top'
                                        >
                                            <button
                                                type='button'
                                                className='lp-btn lp-btn-secondary lp-floor-fold lp-unfold-btn'
                                                onClick={() => setFolded(false)}
                                            >
                                                <FoldCornerIcon />
                                                <span className='lp-floor-fold-label'>
                                                    {t(
                                                        'web.landing.heroUnfoldCta'
                                                    )}
                                                </span>
                                            </button>
                                        </ShortcutTooltip>
                                    </div>
                                </div>
                            </>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className='lp-container lp-floor-brands-mobile'>
                <FloorBrands className='lp-floor-brands-standalone' />
            </div>
        </>
    )
}

const Landing: FC = (): ReactNode => {
    const rootRef = useRef<HTMLDivElement>(null)
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
    const [classicHeroMounted, setClassicHeroMounted] = useState(false)

    useProductDemoTilt(rootRef, classicHeroMounted)

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
            <div className='landing-root' ref={rootRef}>
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
                        <HeroFold
                            onClassicHeroMount={() =>
                                setClassicHeroMounted(true)
                            }
                        />
                        <Flow />
                        <Machines />
                        <Features />
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
