import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
    writeFileSync
} from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { fontFaceCss, fontsForLocale, loadFont, sha256 } from './fonts'
import type { FontPin } from './fonts'
import {
    APPS,
    GENERATOR_PACKAGE_RELS,
    GENERATOR_RELS,
    LOCK_FILE,
    POSTER_CSS,
    POSTER_TEMPLATE,
    generatorSource,
    generatorPackage,
    socialAsset
} from './paths'
import {
    CANONICAL_ORIGIN,
    CANONICAL_RECIPE,
    CANONICAL_VERIFY_RECIPE,
    makeScratch,
    removeScratch,
    runtimeStamp
} from './runtime'
import type { ChromiumOrigin } from './runtime'
import {
    ALIAS_FILE,
    ALIAS_LOCALE,
    POSTER_LOCALES,
    POSTER_VERSION,
    posterCopy,
    posterCss,
    posterFile,
    posterHtml
} from './poster'
import type { PosterCopy, PosterLocale } from './poster'
import { GROOVE_Y, MIN_FONT_PX, VIEWPORT, readLock } from './contract'
import type { PosterLock } from './contract'

// Every knob below that touches the raster is written down rather than left to
// the host, because the point of #625 is that the same source produced
// different cards on different machines. What is still host-dependent is the
// browser build itself, which is why the lock records it.
const LAUNCH_ARGS = [
    '--force-color-profile=srgb',
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--disable-font-subpixel-positioning',
    '--disable-skia-runtime-opts',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-dev-shm-usage'
]

// Ordered: an explicit override, then the build the pinned container ships and
// `pnpm exec playwright install chromium` puts on a workstation, then the usual
// system installs. The first exporter hardcoded the last of these and only the
// macOS one, which is the other half of #625. Inside the canonical container
// the first two collapse onto the same build; $CHROME is the documented escape
// hatch for a host that cannot run it, and its output is not committable.
const SYSTEM_CHROMIUM = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
]

export interface ChromiumChoice {
    executablePath: string
    origin: ChromiumOrigin
}

const isExecutable = (file: string): boolean => {
    try {
        accessSync(file, constants.X_OK)
        return true
    } catch {
        return false
    }
}

export const resolveChromium = (): ChromiumChoice => {
    const override = process.env.CHROME?.trim()
    if (override) {
        if (!isExecutable(override))
            throw new Error(
                `CHROME points at ${override}, which is not executable`
            )
        return { executablePath: override, origin: 'CHROME' }
    }
    let bundled = ''
    try {
        bundled = chromium.executablePath()
    } catch {
        bundled = ''
    }
    if (bundled && isExecutable(bundled))
        return { executablePath: bundled, origin: CANONICAL_ORIGIN }
    const system = SYSTEM_CHROMIUM.find(isExecutable)
    if (system) return { executablePath: system, origin: 'system' }
    throw new Error(
        'no Chromium available\n' +
            '  run `pnpm exec playwright install chromium`, or set CHROME to a Chromium executable\n' +
            `  also looked at: ${SYSTEM_CHROMIUM.join(', ')}`
    )
}

export interface Layout {
    bodyBottom: number
    minFontPx: number
    scrollWidth: number
    scrollHeight: number
    faces: string[]
    unresolved: string[]
}

// No named inner functions: tsx compiles them with esbuild's keepNames helper,
// which does not exist in the page.
const measure = (page: Page): Promise<Layout> =>
    page.evaluate(() => {
        const body = document.querySelector('.p-body')
        if (!body) throw new Error('poster has no .p-body')
        const text = Array.from(
            document.querySelectorAll('.p-brand, .p-domain, .p-h1, .p-sub')
        ) as HTMLElement[]
        const unresolved: string[] = []
        let minFontPx = Number.POSITIVE_INFINITY
        for (const node of text) {
            const style = getComputedStyle(node)
            minFontPx = Math.min(minFontPx, parseFloat(style.fontSize))
            const shorthand = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
            const content = (node.textContent ?? '').replace(/\s+/g, '')
            if (content && !document.fonts.check(shorthand, content))
                unresolved.push(`${node.className}: ${shorthand}`)
        }
        return {
            bodyBottom: body.getBoundingClientRect().bottom,
            minFontPx,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            faces: Array.from(document.fonts)
                .map((face) => `${face.family}/${face.weight}:${face.status}`)
                .sort(),
            unresolved
        }
    })

const assertLayout = (locale: PosterLocale, layout: Layout): void => {
    const wrong: string[] = []
    const loaded = layout.faces.every((face) => face.endsWith(':loaded'))
    if (!loaded || layout.faces.length === 0)
        wrong.push(`faces did not all load: ${layout.faces.join(', ')}`)
    if (layout.unresolved.length > 0)
        wrong.push(
            `text fell back to a host face: ${layout.unresolved.join('; ')}`
        )
    if (layout.bodyBottom > GROOVE_Y)
        wrong.push(
            `content ends at y=${layout.bodyBottom}, past the groove at y=${GROOVE_Y} ` +
                "— it would sit under X's title pill"
        )
    if (layout.minFontPx < MIN_FONT_PX)
        wrong.push(
            `smallest type is ${layout.minFontPx}px, under the ${MIN_FONT_PX}px floor ` +
                'that survives the thumbnail'
        )
    if (
        layout.scrollWidth > VIEWPORT.width ||
        layout.scrollHeight > VIEWPORT.height
    )
        wrong.push(
            `content overflows: ${layout.scrollWidth}x${layout.scrollHeight} ` +
                `past ${VIEWPORT.width}x${VIEWPORT.height}`
        )
    if (wrong.length > 0)
        throw new Error(
            `the ${locale} card breaks its layout contract\n  ` +
                wrong.join('\n  ')
        )
}

export interface RenderedPoster {
    locale: PosterLocale
    file: string
    copy: PosterCopy
    html: string
    png: Buffer
    layout: Layout
    fonts: FontPin[]
}

const styleSheetFor = async (pins: readonly FontPin[]): Promise<string> =>
    [
        ...(await Promise.all(
            pins.map(async (pin) => fontFaceCss(pin, await loadFont(pin)))
        )),
        posterCss()
    ].join('\n\n')

const renderLocale = async (
    browser: Browser,
    scratch: string,
    locale: PosterLocale
): Promise<RenderedPoster> => {
    const pins = fontsForLocale(locale)
    const copy = posterCopy(locale)
    const html = posterHtml({
        locale,
        copy,
        styles: await styleSheetFor(pins)
    })
    // A file:// document rather than setContent: the golden bytes were shot
    // from one, and a real navigation keeps the doctype and <html lang> the
    // CJK rules key off exactly as authored.
    const source = path.join(scratch, `poster-${locale}.html`)
    writeFileSync(source, html)
    const page = await browser.newPage({
        viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
        forcedColors: 'none'
    })
    try {
        await page.goto(`file://${source}`, { waitUntil: 'load' })
        await page.evaluate(() => document.fonts.ready)
        const layout = await measure(page)
        assertLayout(locale, layout)
        const png = await page.screenshot({ type: 'png' })
        return {
            locale,
            file: posterFile(locale),
            copy,
            html,
            png,
            layout,
            fonts: [...pins]
        }
    } finally {
        await page.close()
    }
}

export interface RenderRun {
    posters: RenderedPoster[]
    browserVersion: string
    chromium: ChromiumChoice
}

export const renderPosters = async (): Promise<RenderRun> => {
    const choice = resolveChromium()
    const scratch = makeScratch()
    try {
        const browser = await chromium.launch({
            executablePath: choice.executablePath,
            args: LAUNCH_ARGS
        })
        try {
            const posters: RenderedPoster[] = []
            for (const locale of POSTER_LOCALES)
                posters.push(await renderLocale(browser, scratch, locale))
            return {
                posters,
                browserVersion: browser.version(),
                chromium: choice
            }
        } finally {
            await browser.close()
        }
    } finally {
        removeScratch(scratch)
    }
}

export const buildLock = (run: RenderRun): PosterLock => ({
    version: POSTER_VERSION,
    renderer: {
        ...runtimeStamp(run.chromium),
        browserVersion: run.browserVersion,
        origin: run.chromium.origin,
        platform: `${process.platform}/${process.arch}`,
        viewport: { ...VIEWPORT, deviceScaleFactor: 1 },
        args: LAUNCH_ARGS
    },
    template: sha256(readFileSync(POSTER_TEMPLATE)),
    css: sha256(readFileSync(POSTER_CSS)),
    generator: Object.fromEntries(
        GENERATOR_RELS.map((rel) => [
            rel,
            sha256(readFileSync(generatorSource(rel)))
        ])
    ),
    toolchain: Object.fromEntries(
        Object.keys(GENERATOR_PACKAGE_RELS).map((name) => [
            name,
            (
                JSON.parse(
                    readFileSync(
                        generatorPackage(
                            name as keyof typeof GENERATOR_PACKAGE_RELS
                        ),
                        'utf8'
                    )
                ) as { version: string }
            ).version
        ])
    ),
    alias: { file: ALIAS_FILE, locale: ALIAS_LOCALE },
    apps: APPS,
    locales: Object.fromEntries(
        run.posters.map((poster) => [
            poster.locale,
            {
                file: poster.file,
                copy: poster.copy,
                fonts: poster.fonts.map((pin) => ({
                    family: pin.family,
                    weight: pin.weight,
                    sha256: pin.sha256
                })),
                layout: {
                    bodyBottom: poster.layout.bodyBottom,
                    minFontPx: poster.layout.minFontPx
                },
                bytes: poster.png.length,
                sha256: sha256(poster.png)
            }
        ])
    ) as PosterLock['locales']
})

const writeAssets = (run: RenderRun): void => {
    for (const poster of run.posters)
        for (const app of APPS) {
            writeFileSync(socialAsset(app, poster.file), poster.png)
            console.log(
                `  ${app}/public/social/${poster.file} ` +
                    `(${poster.png.length} bytes, ${sha256(poster.png).slice(0, 12)})`
            )
        }
    const alias = run.posters.find((poster) => poster.locale === ALIAS_LOCALE)
    if (!alias) throw new Error(`no ${ALIAS_LOCALE} poster to alias`)
    for (const app of APPS)
        writeFileSync(socialAsset(app, ALIAS_FILE), alias.png)
    console.log(`  ${ALIAS_FILE} in both apps tracks the ${ALIAS_LOCALE} card`)
}

const verifyAssets = (run: RenderRun): string[] => {
    const drift: string[] = []
    const compare = (file: string, fresh: Buffer): void => {
        for (const app of APPS) {
            const at = socialAsset(app, file)
            if (!existsSync(at)) {
                drift.push(`apps/${app}/public/social/${file} is missing`)
                continue
            }
            const committed = readFileSync(at)
            if (!committed.equals(fresh))
                drift.push(
                    `${app}/public/social/${file}: committed ${sha256(committed).slice(0, 12)} ` +
                        `(${committed.length} bytes), rendered ${sha256(fresh).slice(0, 12)} ` +
                        `(${fresh.length} bytes)`
                )
        }
    }
    for (const poster of run.posters) compare(poster.file, poster.png)
    const alias = run.posters.find((poster) => poster.locale === ALIAS_LOCALE)
    if (alias) compare(ALIAS_FILE, alias.png)
    return drift
}

export const runRender = async (verify: boolean): Promise<void> => {
    const run = await renderPosters()
    const stamp = runtimeStamp(run.chromium)
    console.log(
        `${run.browserVersion} via ${run.chromium.origin} ` +
            `on ${process.platform}/${process.arch}` +
            (stamp.image ? `\n  ${stamp.image} (${stamp.imagePlatform})` : '')
    )
    for (const poster of run.posters)
        console.log(
            `  ${poster.locale}: content ends at y=${poster.layout.bodyBottom}, ` +
                `smallest type ${poster.layout.minFontPx}px`
        )
    if (verify) {
        const drift = verifyAssets(run)
        if (drift.length > 0) {
            const locked = existsSync(LOCK_FILE) ? readLock().renderer : null
            console.error('the committed cards do not match this render:')
            for (const line of drift) console.error(`  ${line}`)
            // Same source, same layout, different pixels is the expected
            // answer from a different runtime: the raster comes out of the
            // browser's own text backend, which is not portable across OSes.
            // Say which runtime shot the committed cards rather than call a
            // runtime difference drift.
            if (locked && locked.image !== stamp.image)
                console.error(
                    `\nThe committed cards were shot in ${locked.image ?? 'no pinned image'} ` +
                        `(${locked.imagePlatform ?? locked.platform}, ${locked.browserVersion}); ` +
                        `this is ${stamp.image ?? 'an uncontainerised renderer'} ` +
                        `(${run.chromium.origin}, ${run.browserVersion}).\n` +
                        `A different runtime means different pixels from the same source — run \`${CANONICAL_VERIFY_RECIPE}\`\n` +
                        'for the canonical comparison, or `pnpm social-card:check` for the browser-free gate CI runs.'
                )
            else
                console.error(
                    '\nSame runtime, different bytes: an input changed and ' +
                        `\`${CANONICAL_RECIPE}\` has not been re-run.`
                )
            process.exitCode = 1
            return
        }
        console.log('committed cards are byte-identical to this render')
        return
    }
    writeAssets(run)
    writeFileSync(LOCK_FILE, `${JSON.stringify(buildLock(run), null, 4)}\n`)
    console.log('  poster.lock.json')
    if (stamp.runtime !== 'container')
        console.warn(
            `\nThis render is not canonical: ${run.chromium.origin} on ` +
                `${process.platform}/${process.arch}, outside the pinned image.\n` +
                'The bytes are fine to look at and wrong to commit — ' +
                '`pnpm social-card:check` will reject them.\n' +
                `Unset CHROME and run \`${CANONICAL_RECIPE}\` to produce the committable cards.`
        )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`)
    await runRender(process.argv.includes('--verify'))
