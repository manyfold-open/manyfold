import type { FC, ReactNode } from 'react'
import { createContext, useCallback, useContext, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowRight, ArrowUpRight, ChevronRight } from 'lucide-react'
import type { ChannelProviderName } from '@manyfold/shared'
import { MarketingFooter } from '@/components/marketing/MarketingFooter'
import { MarketingNav } from '@/components/marketing/MarketingNav'
import AccessGateModal from '@/components/signup-gate/AccessGateModal'
import BrandBetaBadge from '@/components/signup-gate/BrandBetaBadge'
import GateCtaLabel from '@/components/signup-gate/CtaLabel'
import SignupGateModal from '@/components/signup-gate/SignupGateModal'
import { useSignupGateFeature } from '@/components/signup-gate/useSignupGate'
import { SignedIn, SignedOut } from '@/lib/auth'
import { BrandMark } from '@/components/Brand'
import { WorldAgent } from '@/components/landing/WorldAgent'
import { ClaudeCodeColor, CodexColor } from '@/lib/brandIcons'
import {
    ChannelProviderIcon,
    channelDocsHref,
    channelLabel
} from '@/lib/channelMeta'
import { docsHref } from '@/lib/docsLinks'
import { useI18n } from '@/lib/i18n'
import { marketingLinkLanguage } from '@/seo/marketingLinks'
import { useMarketingLanguagePin } from '@/seo/useMarketingLanguagePin'

/* How each channel is actually connected, taken from the provider guides:
   a QR pairing flow, one credential pasted from the platform, or an app the
   platform installs from a manifest Manyfold generates. Which of the three
   it is happens to be the fact a visitor wants before they pick one, so it
   rides on the tile instead of staying in the docs. */
type SetupKind = 'qr' | 'token' | 'app'

interface ChannelTile {
    provider: ChannelProviderName
    setup: SetupKind
}

interface TileGroup {
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
const TILE_GROUPS: TileGroup[] = [
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

const SETUP_LABEL: Record<SetupKind, string> = {
    qr: 'web.channelsPage.setupQr',
    token: 'web.channelsPage.setupToken',
    app: 'web.channelsPage.setupApp'
}

/* channelMeta labels a lark channel "Lark" because that is the provider name
   the product stores; the marketing page has to name both consoles, because
   a Feishu tenant searching this page for "飞书" finds nothing otherwise. */
const tileLabel = (provider: ChannelProviderName): string =>
    provider === 'lark' ? 'Lark / Feishu' : channelLabel(provider)

/* The hero figure is a sky: the two runtimes standing on a planet at the
   bottom edge, the ten channels orbiting above them as bodies.

   The frame is the reference's: the centre of every arc sits on the bottom
   edge of a 1200x480 box, and the radii step past half its width. So the two
   inner rings show a complete crown, the outer two have their crowns cropped
   off the top and read as farther away, and the outermost passes beyond both
   sides — which is what the edge fade is for. */
const SKY = { w: 1200, h: 430, cx: 600, cy: 430, planet: 200 }

type Ring = 1 | 2 | 3 | 4

/* Tighter than one ring-width apart, so the crown of the system sits higher
   in the box and the planet takes less of it: evenly spaced rings pushed the
   whole drawing's weight into the lower half. */
const RING_RADIUS: Record<Ring, number> = { 1: 290, 2: 360, 3: 440, 4: 530 }

/* Laps, not durations: a body crosses the whole visible arc once per lap.
   Multiples of the world's 4.8s bar and 6.4s fan (ScrollyWorld BAR/FAN), and
   longer the farther out the ring — near bodies overtake far ones, which is
   the only cue that makes concentric arcs read as depth rather than as
   decoration. Everything is slow enough to be noticed rather than watched. */
const RING_LAP: Record<Ring, number> = { 1: 24, 2: 32, 3: 43.2, 4: 57.6 }

/* Diameters, and the fraction of each one the provider mark fills. The two
   move together: the disc came down 14% and the fraction went up to match, so
   the marks render at the size they always did with less white around them —
   ten discs of dead margin were reading as bigger objects than the logos they
   carried. The mark is square inside a circle, so its corners sit at 1.41x
   its half-width: 0.62 keeps them about 2 units clear of the edge. */
const BODY_SIZE: Record<Ring, number> = { 1: 38, 2: 33, 3: 28, 4: 25 }
const BODY_MARK = 0.62

interface SkyBody {
    provider: ChannelProviderName
    ring: Ring
    /* Where the body sits at rest, in degrees from straight up. It is a
       starting position, not a fixed one: the value is converted into a
       negative animation offset so the ring arrives already populated
       instead of filling up over the first lap. */
    deg: number
}

/* Placed by eye rather than divided evenly. Even spacing on concentric arcs
   makes a dial; the reference's calm comes from bodies that do not line up
   radially, so no two share an angle and the crowded ring is not the same one
   on both sides. */
const BODIES: SkyBody[] = [
    { provider: 'lark', ring: 1, deg: -62 },
    { provider: 'slack', ring: 1, deg: -37 },
    { provider: 'whatsapp', ring: 1, deg: 31 },
    { provider: 'telegram', ring: 1, deg: 58 },
    { provider: 'matrix', ring: 2, deg: -52 },
    { provider: 'line', ring: 2, deg: -26 },
    { provider: 'weixin', ring: 2, deg: 16 },
    { provider: 'discord', ring: 2, deg: 48 },
    { provider: 'github', ring: 3, deg: -44 },
    { provider: 'linear', ring: 3, deg: 40 }
]

/* The visible half of a ring: a semicircle from the left end of the bottom
   edge, over the crown, to the right end. Sweep 1 with y pointing down is the
   way over the top. */
const arcPath = (r: number): string =>
    `M ${SKY.cx - r},${SKY.cy} A ${r},${r} 0 0,1 ${SKY.cx + r},${SKY.cy}`

/* How far each side of the crown a body travels before its turn restarts.
   Rings are drawn to the bottom edge; a body goes past it.

   The turn is a CSS rotation that wraps from one end of its range to the
   other, so that seam has to fall where nothing is on screen. Past 90 the
   body is under the bottom edge — 50 to 76 units under it, depending on the
   ring — so it has already crossed the bottom fade and gone fully
   transparent before the wrap, and it comes back up the other side inside
   that same fade rather than appearing mid-air. Exactly 90 lands the seam on
   the edge itself, which leaves no margin for the body's own half-height.

   The lp-cl-orbit / lp-cl-upright keyframes carry the same number. */
const BODY_SPAN = 100

/* An angle from the crown, as a negative animation delay, so a ring is
   populated on the first frame instead of filling up over its first lap. */
const orbitDelay = (deg: number, lap: number): string =>
    `${(-((deg + BODY_SPAN) / (BODY_SPAN * 2)) * lap).toFixed(2)}s`

/* A ring is a circle, so turning about its centre traces it exactly and no
   path animation is needed — which matters, because Blink holds an inline
   SVG's SMIL clock at zero until the document's load event: on a cold
   refresh the sky was painted and the bots were already hopping while every
   body sat frozen, waiting for the last font. CSS animations start on the
   first frame the element is styled.

   The arm is a static attribute transform out to the ring; the group around
   it turns, and the body inside unwinds the same turn about its own middle
   so the provider mark stays upright. Both run one clock, in opposite
   directions, and both are linear — arc length on a circle is proportional
   to angle, so this is the constant speed the path animation had. */
const SkyBodyMark: FC<{ body: SkyBody }> = ({ body }): ReactNode => {
    const size = BODY_SIZE[body.ring]
    const lap = RING_LAP[body.ring]
    const turn = {
        animationDuration: `${lap}s`,
        animationDelay: orbitDelay(body.deg, lap)
    }
    return (
        <g className='lp-cl-orbit' style={turn}>
            <g transform={`translate(0 ${-RING_RADIUS[body.ring]})`}>
                <g className='lp-cl-body' style={turn}>
                    <circle
                        r={size / 2}
                        fill='var(--lp-paper-warm)'
                        stroke='var(--lp-line)'
                        strokeWidth='1'
                    />
                    {/* Nested twice on purpose: the outer svg carries the
                        position and the box, and the provider mark inside it
                        has its own viewBox and no size, so it fills that box
                        exactly. */}
                    <svg
                        x={(-size * BODY_MARK) / 2}
                        y={(-size * BODY_MARK) / 2}
                        width={size * BODY_MARK}
                        height={size * BODY_MARK}
                        viewBox='0 0 24 24'
                    >
                        <ChannelProviderIcon provider={body.provider} />
                    </svg>
                </g>
            </g>
        </g>
    )
}

/* Both runtimes stand on the crown of the planet, one step apart, on the
   surface rather than floating over it. Different beats so the two do not
   breathe in unison — the world hands every agent the same clocks on a
   different phase for the same reason. */
const BOTS: Array<{ dx: number; Logo: typeof ClaudeCodeColor; beat: number }> =
    [
        { dx: -24, Logo: ClaudeCodeColor, beat: 0 },
        { dx: 24, Logo: CodexColor, beat: 2 }
    ]

/* Large enough to be one of the two things this figure is about, and no
   larger: the antenna lamp clears the innermost ring by about 30 units at
   this scale, and past it the bot starts colliding with the orbit. */
const BOT_SCALE = 1.15

const botY = (dx: number): number =>
    SKY.cy - Math.sqrt(SKY.planet * SKY.planet - dx * dx)

interface GateValue {
    open: () => void
    openGate: () => void
    loaded: boolean
    enabled: boolean
}

const GateContext = createContext<GateValue>({
    open: () => {},
    openGate: () => {},
    loaded: false,
    enabled: false
})

const useGate = (): GateValue => useContext(GateContext)

/* The same three states the landing hero resolves, so a visitor who arrives
   here from an ad meets the identical flow rather than a second, softer one:

     signed in            -> open the workspace, not a sign-up
     gate off             -> one button straight to /login
     gate on              -> request access, or sign in if you already can

   The landing expresses the third state through .lp-step-cta*, whose rules
   are not in styles.css — only Landing.tsx references those names, so its
   badges currently render unstyled (both the full label and the numeral
   show, where one is meant to replace the other by width). This page takes
   the behaviour and leaves that markup alone.

   The page's own secondary action rides along in the two states that have
   room for it; when the gate offers its own second path, that path wins the
   slot rather than competing with a third button. */
const PrimaryCta: FC<{
    labelKey: string
    secondary?: ReactNode
}> = ({ labelKey, secondary }): ReactNode => {
    const { t } = useI18n()
    const gate = useGate()
    const primary = (to: string, label: ReactNode): ReactNode => (
        <Link to={to} className='lp-btn lp-btn-primary'>
            {label}
            <ArrowRight className='lp-arr' />
        </Link>
    )
    return (
        <>
            <SignedOut>
                {!gate.loaded ? null : gate.enabled ? (
                    <>
                        <button
                            type='button'
                            onClick={gate.open}
                            className='lp-btn lp-btn-primary'
                        >
                            <GateCtaLabel />
                            <ArrowRight className='lp-arr' />
                        </button>
                        <button
                            type='button'
                            onClick={gate.openGate}
                            className='lp-btn lp-btn-secondary'
                        >
                            {t('web.landing.signIn')}
                        </button>
                    </>
                ) : (
                    <>
                        {primary('/login', t(labelKey))}
                        {secondary}
                    </>
                )}
            </SignedOut>
            <SignedIn>
                {primary('/workspace', t('web.landing.openWorkspace'))}
                {secondary}
            </SignedIn>
        </>
    )
}

const GateBadge: FC = (): ReactNode => {
    const gate = useGate()
    if (!gate.enabled) return null
    return <BrandBetaBadge />
}

const SkyFigure: FC = (): ReactNode => (
    <div className='lp-cl-sky' aria-hidden='true'>
        {/* `slice` rather than the default `meet`: on a narrow screen the
            container goes squarer and the figure scales up and crops its own
            sides instead of shrinking the planet and the bots to specks.

            Anchored to the bottom of its box, not the middle. The planet's
            centre is the bottom edge of the viewBox, so a box shorter than
            the drawing has to lose its crop off the top — where the outer
            rings are already meant to run out of frame — and never off the
            bottom, which is the planet itself. The box is now whatever the
            first screen has left over, so that case is the normal one. */}
        <svg
            viewBox={`0 0 ${SKY.w} ${SKY.h}`}
            preserveAspectRatio='xMidYMax slice'
            fill='none'
        >
            <defs>
                {/* Lit from above, like the reference: the crown catches the
                    light and the body falls away into the page. The far stop
                    is the sunk canvas, not another near-white — three shades
                    of paper read as a flat arch rather than as a sphere. */}
                <radialGradient
                    id='lp-cl-planet'
                    gradientUnits='userSpaceOnUse'
                    cx={SKY.cx}
                    cy={SKY.cy - SKY.planet * 0.82}
                    r={SKY.planet * 1.15}
                >
                    <stop offset='0' stopColor='var(--lp-paper-warm)' />
                    <stop offset='0.45' stopColor='var(--lp-paper)' />
                    <stop offset='1' stopColor='var(--lp-bg-deep)' />
                </radialGradient>
            </defs>

            {/* Each ring is two strokes on one path, the way the world draws
                a wire: a wide translucent bloom under a thin core, both in
                --lp-w-wire so they climb the Iris ramp together per theme.
                The same pair draws the feed wires further down the page. */}
            {Object.values(RING_RADIUS).map((r) => (
                <g key={r}>
                    <path className='lp-cl-wire-bloom' d={arcPath(r)} />
                    <path className='lp-cl-wire' d={arcPath(r)} />
                </g>
            ))}

            {/* Every orbit turns about the planet's centre, so the set
                shares one translate to it and each body's arm is a radius up
                from there. */}
            <g transform={`translate(${SKY.cx} ${SKY.cy})`}>
                {BODIES.map((body) => (
                    <SkyBodyMark key={body.provider} body={body} />
                ))}
            </g>

            {/* Drawn after the bodies so the planet owns the foreground. Its
                edge is one neutral hairline: the rings are what this figure
                spends its accent on, and a lit rim here competed with them. */}
            <circle
                cx={SKY.cx}
                cy={SKY.cy}
                r={SKY.planet}
                fill='url(#lp-cl-planet)'
            />
            <circle
                className='lp-cl-horizon'
                cx={SKY.cx}
                cy={SKY.cy}
                r={SKY.planet}
            />

            {BOTS.map(({ dx, Logo, beat }) => (
                <WorldAgent
                    key={dx}
                    x={SKY.cx + dx}
                    y={botY(dx)}
                    scale={BOT_SCALE}
                    Logo={Logo}
                    beat={beat}
                    motion='hop'
                />
            ))}
        </svg>
    </div>
)

const Hero: FC = (): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    /* The docs carry their language in the path, and this page is served per
       language, so the button follows the one its own URL pins. */
    const docs = docsHref(
        marketingLinkLanguage(pathname, language) === 'zh'
            ? '/zh/docs/channels/'
            : '/docs/channels/'
    )
    return (
        <section className='lp-section lp-cl-hero'>
            <div className='lp-container lp-cl-hero-copy'>
                <div className='lp-eyebrow'>
                    {t('web.channelsPage.heroEyebrow')}
                </div>
                <h1 className='lp-h1'>
                    {t('web.channelsPage.heroTitle')}{' '}
                    <span className='lp-h-accent'>
                        {t('web.channelsPage.heroTitleAccent')}
                    </span>
                </h1>
                <p className='lp-lead'>{t('web.channelsPage.heroLead')}</p>
                <div className='lp-cl-hero-ctas'>
                    <PrimaryCta
                        labelKey='web.channelsPage.heroPrimary'
                        secondary={
                            <a
                                href={docs}
                                className='lp-btn lp-btn-secondary'
                            >
                                {t('web.channelsPage.heroSecondary')}
                            </a>
                        }
                    />
                </div>
            </div>
            {/* Outside the container: the sky runs the full width and fades
                out at its own edges, so a column gutter would cut it. */}
            <SkyFigure />
        </section>
    )
}

/* The whole tile is the link to that provider's guide, rather than a card
   with a link inside it: this grid is a catalogue, and the question a visitor
   has in front of it — "how do I connect that one" — has exactly one answer
   per tile. The arrow is drawn at rest, not on hover, because a touch screen
   never hovers and would otherwise have no way to know the tile leads
   somewhere. */
const AppTile: FC<{ tile: ChannelTile }> = ({ tile }): ReactNode => {
    const { t, language } = useI18n()
    const { pathname } = useLocation()
    const href = channelDocsHref(
        tile.provider,
        marketingLinkLanguage(pathname, language)
    )
    const label = tileLabel(tile.provider)
    return (
        <a
            className='lp-cl-tile'
            href={href ?? undefined}
            aria-label={`${label} — ${t('web.channelsPage.appsGuide')}`}
        >
            <span className='lp-cl-tile-mark'>
                <ChannelProviderIcon provider={tile.provider} />
            </span>
            <ArrowUpRight className='lp-cl-tile-arrow' aria-hidden='true' />
            <span className='lp-cl-tile-name'>{label}</span>
            <span className='lp-cl-setup'>{t(SETUP_LABEL[tile.setup])}</span>
        </a>
    )
}

const Apps: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-cl-apps' className='lp-section lp-cl-apps'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.channelsPage.appsEyebrow')}
                    </div>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.appsTitle')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.channelsPage.appsTitleAccent')}
                        </span>
                    </h2>
                </div>
                {TILE_GROUPS.map((group) => (
                    <div key={group.labelKey} className='lp-cl-group'>
                        <h3 className='lp-cl-group-head'>{t(group.labelKey)}</h3>
                        <div className='lp-cl-grid'>
                            {group.tiles.map((tile) => (
                                <AppTile key={tile.provider} tile={tile} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    )
}

const Setup: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section id='lp-cl-setup' className='lp-section lp-cl-setup-section'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.channelsPage.stepsEyebrow')}
                    </div>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.stepsTitle')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.channelsPage.stepsTitleAccent')}
                        </span>
                    </h2>
                </div>
                <ol className='lp-cl-steps'>
                    <li className='lp-cl-step'>
                        <span className='lp-cl-step-n'>1</span>
                        <h3 className='lp-cl-step-title'>
                            {t('web.channelsPage.step1Title')}
                        </h3>
                        <p>{t('web.channelsPage.step1Body')}</p>
                        <ChevronRight
                            className='lp-cl-step-arrow'
                            aria-hidden='true'
                        />
                    </li>
                    <li className='lp-cl-step'>
                        <span className='lp-cl-step-n'>2</span>
                        <h3 className='lp-cl-step-title'>
                            {t('web.channelsPage.step2Title')}
                        </h3>
                        <p>{t('web.channelsPage.step2Body')}</p>
                        <ChevronRight
                            className='lp-cl-step-arrow'
                            aria-hidden='true'
                        />
                    </li>
                    <li className='lp-cl-step'>
                        <span className='lp-cl-step-n'>3</span>
                        <h3 className='lp-cl-step-title'>
                            {t('web.channelsPage.step3Title')}
                        </h3>
                        <p>{t('web.channelsPage.step3Body')}</p>
                    </li>
                </ol>
            </div>
        </section>
    )
}

/* The feed is drawn 1:1 against the entrance column rather than in
   percentages of the row. The column is stretched to the height of the panel
   beside it and centres its entrances inside that, so a percentage mapping
   drifts as soon as the panel's height changes — measured at 11px off at the
   outer two wires. These are the same two numbers the stylesheet gives the
   entrances, so the wires leave exactly at their midpoints. */
const FEED = { w: 76, entry: 50, gap: 10 }
const FEED_H = FEED.entry * 4 + FEED.gap * 3
const FEED_AT = [0, 1, 2, 3].map(
    (i) => i * (FEED.entry + FEED.gap) + FEED.entry / 2
)

/* Out horizontally, one turn, in at the panel's edge — the shape the world
   uses for the light running between its planes. */
const feedPath = (y: number): string =>
    `M 0,${y} C ${FEED.w / 2},${y} ${FEED.w / 2},${FEED_H / 2} ${FEED.w},${FEED_H / 2}`

/* The sessions a visitor sees in the mock workspace are the same four
   conversations the rest of the page talks about, so the list reads as the
   other end of those chats rather than as invented sample data. */
const SYNC_ROWS: Array<{
    provider: ChannelProviderName | null
    key: string
    age: string
}> = [
    { provider: 'whatsapp', key: 'web.channelsPage.syncRowCi', age: '2m' },
    { provider: 'slack', key: 'web.channelsPage.syncRowRelease', age: '1h' },
    { provider: 'lark', key: 'web.channelsPage.syncRowFunnel', age: '3h' },
    { provider: 'telegram', key: 'web.channelsPage.syncRowAudit', age: '9h' },
    { provider: null, key: 'web.channelsPage.syncRowWeb', age: '1d' }
]

const SYNC_ENTRIES: Array<{
    provider: ChannelProviderName | null
    key: string
}> = [
    { provider: 'whatsapp', key: 'web.channelsPage.syncEntryPhone' },
    { provider: 'slack', key: 'web.channelsPage.syncEntryTeam' },
    { provider: 'lark', key: 'web.channelsPage.syncEntryGroup' },
    { provider: null, key: 'web.channelsPage.syncEntryWeb' }
]

const SYNC_POINTS = ['History', 'Files', 'Bill', 'Settings'] as const

const Sync: FC = (): ReactNode => {
    const { t } = useI18n()
    return (
        <section className='lp-section lp-cl-sync'>
            <div className='lp-container'>
                <div className='lp-section-head'>
                    <div className='lp-eyebrow'>
                        {t('web.channelsPage.syncEyebrow')}
                    </div>
                    <h2 className='lp-h2'>
                        {t('web.channelsPage.syncTitle')}{' '}
                        <span className='lp-h-accent'>
                            {t('web.channelsPage.syncTitleAccent')}
                        </span>
                    </h2>
                    <p className='lp-lead'>{t('web.channelsPage.syncLead')}</p>
                </div>
                <div className='lp-cl-flow'>
                    <ul className='lp-cl-entries'>
                        {SYNC_ENTRIES.map((entry) => (
                            <li key={entry.key}>
                                <span className='lp-cl-entry-mark'>
                                    {entry.provider ? (
                                        <ChannelProviderIcon
                                            provider={entry.provider}
                                        />
                                    ) : (
                                        <i className='lp-cl-entry-mf' />
                                    )}
                                </span>
                                {t(entry.key)}
                            </li>
                        ))}
                    </ul>
                    {/* Four wires converging on one point, drawn like the
                        world's feed: each leaves its entrance horizontally,
                        turns once, and arrives at the panel's edge. */}
                    <span className='lp-cl-converge' aria-hidden='true'>
                        <svg viewBox={`0 0 ${FEED.w} ${FEED_H}`} fill='none'>
                            {FEED_AT.map((y) => (
                                <g key={y}>
                                    <path
                                        className='lp-cl-wire-bloom'
                                        d={feedPath(y)}
                                    />
                                    <path
                                        className='lp-cl-wire'
                                        d={feedPath(y)}
                                    />
                                </g>
                            ))}
                        </svg>
                    </span>
                    <div className='lp-cl-ws'>
                        {/* The product's own shell in miniature. A logo
                            stuck on a card still reads as a card; the rail
                            down the left is the shape of the actual app, so
                            the panel reads as a screen inside it. The nav
                            marks below the brand are deliberately blank —
                            naming destinations here would invite reading a
                            menu that is not the point of the figure. */}
                        <div className='lp-cl-ws-rail' aria-hidden='true'>
                            <BrandMark className='lp-cl-ws-brand' />
                            <span className='lp-cl-ws-nav'>
                                <i />
                                <i />
                                <i />
                            </span>
                        </div>
                        <div className='lp-cl-ws-main'>
                            <div className='lp-cl-ws-head'>
                                {t('web.channelsPage.syncTabSessions')}
                            </div>
                            <ul className='lp-cl-ws-list'>
                                {SYNC_ROWS.map((row) => (
                                    <li key={row.key}>
                                        <span className='lp-cl-ws-src'>
                                            {row.provider ? (
                                                <ChannelProviderIcon
                                                    provider={row.provider}
                                                />
                                            ) : (
                                                <i className='lp-cl-entry-mf' />
                                            )}
                                        </span>
                                        <span className='lp-cl-ws-title'>
                                            {t(row.key)}
                                        </span>
                                        <span className='lp-cl-ws-age'>
                                            {row.age}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                            <div className='lp-cl-ws-foot'>
                                {t('web.channelsPage.syncWsFoot')}
                            </div>
                        </div>
                    </div>
                </div>
                <ul className='lp-cl-points'>
                    {SYNC_POINTS.map((point) => (
                        <li key={point}>
                            <b>{t(`web.channelsPage.syncPoint${point}`)}</b>
                            <p>{t(`web.channelsPage.syncPoint${point}Body`)}</p>
                        </li>
                    ))}
                </ul>
            </div>
        </section>
    )
}

/* Three, not six. A row of six short claims reads as a footer nobody
   parses; these are the three a visitor actually weighs before signing up. */
const ChannelsLanding: FC = (): ReactNode => {
    useMarketingLanguagePin()
    const signupGateFeature = useSignupGateFeature()
    const [gateOpen, setGateOpen] = useState(false)
    const [gateFormOpen, setGateFormOpen] = useState(false)
    const openGate = useCallback((): void => setGateOpen(true), [])
    const closeGate = useCallback((): void => setGateOpen(false), [])
    const openGateForm = useCallback((): void => {
        setGateOpen(false)
        setGateFormOpen(true)
    }, [])
    const closeGateForm = useCallback((): void => setGateFormOpen(false), [])

    return (
        <GateContext.Provider
            value={{
                open: openGateForm,
                openGate,
                loaded: signupGateFeature.loaded,
                enabled: signupGateFeature.enabled
            }}
        >
            <div className='landing-root'>
                <div className='lp-z lp-cl-root'>
                    <MarketingNav
                        badge={<GateBadge />}
                        languagePaths={{ en: '/channels', zh: '/zh/channels' }}
                    />
                    <main>
                        <Hero />
                        <Apps />
                        <Setup />
                        <Sync />
                    </main>
                    <MarketingFooter badge={<GateBadge />} />
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
        </GateContext.Provider>
    )
}

export default ChannelsLanding
