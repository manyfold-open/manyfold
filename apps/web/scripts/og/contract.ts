import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fontsForLocale, sha256 } from './fonts'
import {
    APPS,
    DOCS_LAYOUT,
    GENERATOR_PACKAGE_RELS,
    GENERATOR_RELS,
    LOCK_FILE,
    POSTER_CSS,
    POSTER_TEMPLATE,
    WEB_HEAD,
    generatorSource,
    generatorPackage,
    socialAsset,
    socialDir
} from './paths'
import type { AppName } from './paths'
import {
    ALIAS_FILE,
    ALIAS_LOCALE,
    HERO_KEYS,
    POSTER_LOCALES,
    POSTER_VERSION,
    RETIRED_CARDS,
    posterCopy,
    posterFile
} from './poster'
import type { PosterCopy, PosterLocale, RetiredCards } from './poster'
import {
    CANONICAL_BROWSER_VERSION,
    CANONICAL_IMAGE,
    CANONICAL_NODE_PLATFORM,
    CANONICAL_ORIGIN,
    CANONICAL_PLATFORM,
    CANONICAL_RECIPE
} from './runtime'
import type { RuntimeStamp } from './runtime'

// The card is a still, and a still cannot be re-derived in CI: a browser build
// bakes its own rasteriser into the pixels. So the committed PNGs are the
// artifact and this file is the receipt that ties them to the sources they came
// from — copy, template, stylesheet, faces, geometry. Everything here runs off
// files alone, no browser, so it can gate every pull request.

export const VIEWPORT = { width: 1200, height: 630 } as const

// X stamps the card title as a dark pill over the lower-left of the image, and
// renders the card about 504px wide. The groove marks the top of that band; the
// floor is the smallest type that still resolves at 0.42x.
export const GROOVE_Y = 520
export const MIN_FONT_PX = 22

export interface PosterLockFont {
    family: string
    weight: number
    sha256: string
}

export interface PosterLockLocale {
    file: string
    copy: PosterCopy
    fonts: PosterLockFont[]
    layout: { bodyBottom: number; minFontPx: number }
    bytes: number
    sha256: string
}

export interface PosterLock {
    version: string
    renderer: RuntimeStamp & {
        browserVersion: string
        origin: string
        platform: string
        viewport: { width: number; height: number; deviceScaleFactor: number }
        args: string[]
    }
    template: string
    css: string
    generator: Record<string, string>
    toolchain: Record<string, string>
    alias: { file: string; locale: PosterLocale }
    apps: AppName[]
    locales: Record<PosterLocale, PosterLockLocale>
}

export const readLock = (): PosterLock =>
    JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as PosterLock

const RERENDER = `run \`${CANONICAL_RECIPE}\` and commit the result`

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const pngSize = (bytes: Buffer): { width: number; height: number } | null =>
    bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
        ? null
        : { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }

const socialRefs = (file: string): string[] => {
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(/\/social\/manyfold-og[\w-]*\.png/g)]
        .map((match) => match[0])
        .sort()
}

const unique = (values: string[]): string[] => [...new Set(values)].sort()

const checkCopy = (lock: PosterLock, fail: (why: string) => void): void => {
    for (const locale of POSTER_LOCALES) {
        const live = posterCopy(locale)
        const baked = lock.locales[locale]?.copy
        if (!baked) {
            fail(`poster.lock.json has no ${locale} entry — ${RERENDER}`)
            continue
        }
        for (const key of HERO_KEYS)
            if (baked[key] !== live[key])
                fail(
                    `the ${locale} card was rendered from stale copy for ${key}\n` +
                        `    card:    ${JSON.stringify(baked[key])}\n` +
                        `    catalog: ${JSON.stringify(live[key])}\n` +
                        `    ${RERENDER}`
                )
    }
}

const checkInputs = (lock: PosterLock, fail: (why: string) => void): void => {
    const template = sha256(readFileSync(POSTER_TEMPLATE))
    if (lock.template !== template)
        fail(
            `poster.template.html changed since the cards were shot — ${RERENDER}`
        )
    const css = sha256(readFileSync(POSTER_CSS))
    if (lock.css !== css)
        fail(`poster.css changed since the cards were shot — ${RERENDER}`)
    const recorded = lock.generator ?? {}
    const listed = Object.keys(recorded).sort()
    const expected = [...GENERATOR_RELS].sort()
    if (listed.join('|') !== expected.join('|'))
        fail(
            'poster.lock.json fingerprints a different generator source set\n' +
                `    card:     ${listed.join(', ') || '(none)'}\n` +
                `    expected: ${expected.join(', ')}\n` +
                `    ${RERENDER}`
        )
    for (const rel of GENERATOR_RELS) {
        const actual = sha256(readFileSync(generatorSource(rel)))
        if (recorded[rel] !== actual)
            fail(`${rel} changed since the cards were shot — ${RERENDER}`)
    }
    const toolchain = lock.toolchain ?? {}
    const packages = Object.keys(GENERATOR_PACKAGE_RELS).sort()
    if (Object.keys(toolchain).sort().join('|') !== packages.join('|'))
        fail(
            'poster.lock.json fingerprints a different generator toolchain\n' +
                `    card:     ${Object.keys(toolchain).sort().join(', ') || '(none)'}\n` +
                `    expected: ${packages.join(', ')}\n` +
                `    ${RERENDER}`
        )
    for (const name of packages) {
        const manifest = JSON.parse(
            readFileSync(
                generatorPackage(name as keyof typeof GENERATOR_PACKAGE_RELS),
                'utf8'
            )
        ) as { version?: string }
        if (toolchain[name] !== manifest.version)
            fail(
                `${name} is ${manifest.version ?? '(unknown)'}, but the cards were shot with ` +
                    `${toolchain[name] ?? '(unrecorded)'} — ${RERENDER}`
            )
    }
    for (const locale of POSTER_LOCALES) {
        const baked = lock.locales[locale]?.fonts ?? []
        const pins = fontsForLocale(locale).map(
            (pin) => `${pin.family} ${pin.weight} ${pin.sha256}`
        )
        const used = baked.map(
            (font) => `${font.family} ${font.weight} ${font.sha256}`
        )
        if (used.join('|') !== pins.join('|'))
            fail(
                `the ${locale} card was shot with different faces than fonts.ts pins now\n` +
                    `    card:    ${used.join(', ') || '(none)'}\n` +
                    `    fonts.ts: ${pins.join(', ')}\n` +
                    `    ${RERENDER}`
            )
    }
}

const checkLayout = (lock: PosterLock, fail: (why: string) => void): void => {
    for (const locale of POSTER_LOCALES) {
        const layout = lock.locales[locale]?.layout
        if (!layout) continue
        if (layout.bodyBottom > GROOVE_Y)
            fail(
                `the ${locale} card ends at y=${layout.bodyBottom}, past the groove at y=${GROOVE_Y}`
            )
        if (layout.minFontPx < MIN_FONT_PX)
            fail(
                `the ${locale} card sets ${layout.minFontPx}px type, under the ${MIN_FONT_PX}px floor`
            )
    }
}

// Which runtime shot the committed cards, checked against the only one whose
// bytes are committable. The recipe stamps the lock from the image it launched
// and runtimeStamp refuses to stamp anything that is not that image, so this
// cannot drift from what ran; what it does catch is a lock produced through the
// $CHROME escape hatch, and a lock left behind when the pinned image is bumped.
// Every field the one-legal-producer claim rests on is pinned in source here,
// not just the ones the stamp happens to write.
const checkRuntime = (lock: PosterLock, fail: (why: string) => void): void => {
    const renderer = lock.renderer
    if (
        renderer?.runtime !== 'container' ||
        renderer.image !== CANONICAL_IMAGE
    ) {
        fail(
            'the committed cards did not come from the canonical renderer\n' +
                `    card:      ${renderer?.image ?? `${renderer?.origin ?? 'unknown'} on ${renderer?.platform ?? 'unknown'}`}\n` +
                `    canonical: ${CANONICAL_IMAGE}\n` +
                '    CHROME renders for review, not for committing — ' +
                `${RERENDER} with CHROME unset`
        )
        return
    }
    if (
        renderer.imagePlatform !== CANONICAL_PLATFORM ||
        renderer.platform !== CANONICAL_NODE_PLATFORM
    )
        fail(
            `the committed cards were shot on ${renderer.imagePlatform} (${renderer.platform}), ` +
                `not ${CANONICAL_PLATFORM} (${CANONICAL_NODE_PLATFORM}) — ${RERENDER}`
        )
    if (renderer.browserVersion !== CANONICAL_BROWSER_VERSION)
        fail(
            `the committed cards were shot with Chromium ${renderer.browserVersion}, but the ` +
                `pinned digest ships ${CANONICAL_BROWSER_VERSION} — a lock naming another build ` +
                `did not come out of that image — ${RERENDER}`
        )
    if (renderer.origin !== CANONICAL_ORIGIN)
        fail(
            `the committed cards were shot with Chromium from ${renderer.origin}, not the ` +
                `${CANONICAL_ORIGIN} build the image ships — ${RERENDER}`
        )
}

// The lock lists the apps and locales it covers, and everything below iterates
// those lists. So the lists themselves are checked against the source of truth
// first: a lock that quietly dropped `docs`, or `zh`, would otherwise silence
// every rule about the artifacts it dropped.
const checkCoverage = (lock: PosterLock, fail: (why: string) => void): void => {
    const listed = [...(lock.apps ?? [])].sort().join(', ')
    const known = [...APPS].sort().join(', ')
    if (listed !== known)
        fail(
            `poster.lock.json covers ${listed || '(no apps)'}, but the card ships in ${known} — ${RERENDER}`
        )
    const locales = Object.keys(lock.locales ?? {})
        .sort()
        .join(', ')
    const wanted = [...POSTER_LOCALES].sort().join(', ')
    if (locales !== wanted)
        fail(
            `poster.lock.json covers ${locales || '(no locales)'}, but the card ships in ${wanted} — ${RERENDER}`
        )
    if (lock.alias?.locale !== ALIAS_LOCALE)
        fail(
            `poster.lock.json aliases the ${lock.alias?.locale} card, but ${ALIAS_FILE} is the ` +
                `${ALIAS_LOCALE} name — ${RERENDER}`
        )
}

// Retired versions are historical artifacts: their URLs are cached in clients
// and quoted in posts, so they keep their own filenames and their own bytes.
// Both apps have to publish the same set of them, and the same bytes for each,
// or one surface is serving art the other retired — and both apps agreeing on a
// rewrite is still a rewrite, which is what RETIRED_CARDS is for.
export const CARD_FILE = /^manyfold-og(?:-[a-z]{2})?-v\d+\.png$/

export type Published = ReadonlyMap<AppName, ReadonlyMap<string, string>>

// Kept pure and separate from the disk walk below, and taking the freeze as an
// argument, so the tests can hand it a half-published tree — an app short one
// retired card, two apps agreeing on the wrong bytes for one, a version frozen
// while it still ships — without doctoring the repository to prove each rule
// bites.
export const publishedFailures = (
    published: Published,
    retired: RetiredCards = RETIRED_CARDS
): string[] => {
    const failures: string[] = []
    const current = new Set<string>([
        ...POSTER_LOCALES.map(posterFile),
        ALIAS_FILE
    ])
    for (const file of Object.keys(retired).sort())
        if (current.has(file))
            failures.push(
                `the retired freeze in poster.ts covers ${file}, which the card still ships as ` +
                    `${POSTER_VERSION}\n` +
                    '    a version is frozen by the bump that retires it, not while it is current'
            )
    const union = unique(
        [...published.values()]
            .flatMap((files) => [...files.keys()])
            .concat(ALIAS_FILE, ...Object.keys(retired))
    )
    for (const file of union) {
        const digests = new Map<AppName, string>()
        for (const app of APPS) {
            const digest = published.get(app)?.get(file)
            if (digest === undefined) {
                failures.push(
                    `apps/${app}/public/social/${file} is missing, but the card ships from every app\n` +
                        '    a retired version keeps its filename and its bytes in both'
                )
                continue
            }
            digests.set(app, digest)
        }
        if (new Set(digests.values()).size > 1)
            failures.push(
                `${file} differs between apps: ` +
                    [...digests]
                        .map(([app, digest]) => `${app} ${digest.slice(0, 12)}`)
                        .join(', ')
            )
        const frozen = retired[file]
        if (frozen === undefined) {
            if (CARD_FILE.test(file) && !current.has(file))
                failures.push(
                    `${file} is published, is not the current ${POSTER_VERSION} card, and is not ` +
                        'in the retired freeze in apps/web/scripts/og/poster.ts\n' +
                        `    add it to RETIRED_CARDS: '${file}': '${[...digests.values()][0] ?? '<sha256>'}'`
                )
            continue
        }
        for (const [app, digest] of digests)
            if (digest !== frozen)
                failures.push(
                    `apps/${app}/public/social/${file} is not the bytes it was retired with\n` +
                        `    on disk:  ${digest}\n` +
                        `    retired:  ${frozen}\n` +
                        '    a cached URL cannot be told its pixels moved: restore the bytes, ' +
                        'and ship new art under a new version'
                )
    }
    for (const locale of POSTER_LOCALES)
        if (!union.includes(posterFile(locale)))
            failures.push(
                `no app publishes ${posterFile(locale)}, the current ${locale} card — ${RERENDER}`
            )
    return failures
}

const readPublished = (fail: (why: string) => void): Published =>
    new Map(
        APPS.map((app) => {
            const dir = socialDir(app)
            if (!existsSync(dir)) {
                fail(`apps/${app}/public/social is missing`)
                return [app, new Map<string, string>()]
            }
            const files = readdirSync(dir).filter(
                (file) => CARD_FILE.test(file) || file === ALIAS_FILE
            )
            return [
                app,
                new Map(
                    files.map((file) => [
                        file,
                        sha256(readFileSync(socialAsset(app, file)))
                    ])
                )
            ]
        })
    )

const checkPublished = (fail: (why: string) => void): void => {
    for (const why of publishedFailures(readPublished(fail))) fail(why)
}

const checkAssets = (lock: PosterLock, fail: (why: string) => void): void => {
    const read = (app: AppName, file: string): Buffer | null => {
        const at = socialAsset(app, file)
        if (!existsSync(at)) {
            fail(`apps/${app}/public/social/${file} is missing — ${RERENDER}`)
            return null
        }
        return readFileSync(at)
    }
    for (const locale of POSTER_LOCALES) {
        const entry = lock.locales[locale]
        if (!entry) continue
        if (entry.file !== posterFile(locale))
            fail(
                `poster.lock.json names ${entry.file} for ${locale}, but the version is ` +
                    `${POSTER_VERSION} so it should be ${posterFile(locale)} — ${RERENDER}`
            )
        for (const app of APPS) {
            const bytes = read(app, entry.file)
            if (!bytes) continue
            const digest = sha256(bytes)
            if (digest !== entry.sha256)
                fail(
                    `apps/${app}/public/social/${entry.file} is not the card poster.lock.json records\n` +
                        `    on disk: ${digest} (${bytes.length} bytes)\n` +
                        `    locked:  ${entry.sha256} (${entry.bytes} bytes)\n` +
                        `    ${RERENDER}`
                )
            const size = pngSize(bytes)
            if (!size)
                fail(`apps/${app}/public/social/${entry.file} is not a PNG`)
            else if (
                size.width !== VIEWPORT.width ||
                size.height !== VIEWPORT.height
            )
                fail(
                    `apps/${app}/public/social/${entry.file} is ${size.width}x${size.height}, ` +
                        `not ${VIEWPORT.width}x${VIEWPORT.height}`
                )
        }
    }
    // The unversioned name predates the suffix and stays current: links already
    // point at it, so it has to keep resolving to today's card.
    const aliased = lock.locales[lock.alias.locale]
    for (const app of APPS) {
        const bytes = read(app, lock.alias.file)
        if (!bytes || !aliased) continue
        if (sha256(bytes) !== aliased.sha256)
            fail(
                `apps/${app}/public/social/${lock.alias.file} is not the current ` +
                    `${lock.alias.locale} card — ${RERENDER}`
            )
    }
}

const checkReferences = (
    lock: PosterLock,
    fail: (why: string) => void
): void => {
    const expected = unique(
        POSTER_LOCALES.map((locale) => `/social/${lock.locales[locale].file}`)
    )
    for (const [label, file] of [
        ['apps/web/src/seo/head.ts', WEB_HEAD],
        ['apps/docs/src/layouts/BaseLayout.astro', DOCS_LAYOUT]
    ] as const) {
        const found = unique(socialRefs(file))
        if (found.join('|') !== expected.join('|'))
            fail(
                `${label} points at a different set of cards than poster.lock.json\n` +
                    `    page:  ${found.join(', ') || '(none)'}\n` +
                    `    cards: ${expected.join(', ')}\n` +
                    '    bump both together: the filename is the cache bust'
            )
    }
    if (lock.alias.file !== ALIAS_FILE)
        fail(
            `poster.lock.json aliases ${lock.alias.file}, but the long-lived name is ${ALIAS_FILE}`
        )
    if (lock.version !== POSTER_VERSION)
        fail(
            `poster.lock.json is version ${lock.version}, poster.ts is ${POSTER_VERSION} — ${RERENDER}`
        )
}

// The lock is a parameter so the tests can hand in a doctored one and prove
// each rule actually fails, rather than trusting a check that has only ever
// been run against a passing tree.
export const posterContractFailures = (
    lock: PosterLock | null = existsSync(LOCK_FILE) ? readLock() : null
): string[] => {
    if (!lock) return [`poster.lock.json is missing — ${RERENDER}`]
    const failures: string[] = []
    const fail = (why: string): void => {
        failures.push(why)
    }
    const missing = POSTER_LOCALES.filter((locale) => !lock.locales[locale])
    if (missing.length > 0)
        return [
            `poster.lock.json is missing ${missing.join(', ')} — ${RERENDER}`
        ]
    checkRuntime(lock, fail)
    checkCoverage(lock, fail)
    checkCopy(lock, fail)
    checkInputs(lock, fail)
    checkLayout(lock, fail)
    checkPublished(fail)
    checkAssets(lock, fail)
    checkReferences(lock, fail)
    return failures
}
