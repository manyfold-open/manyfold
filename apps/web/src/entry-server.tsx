import { StrictMode } from 'react'
import { StaticRouter } from 'react-router-dom/server'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setLanguage, type Language } from '@manyfold/i18n'
import '@/lib/editionFrameworks'
import App, { marketingRouteModule } from '@/App'
import AnalyticsConsentBanner from '@/components/AnalyticsConsentBanner'
import { AppAuthProvider } from '@/lib/auth'
import { FontSizeProvider } from '@/lib/fontSize'
import { I18nProvider, loadWebLanguage } from '@/lib/i18n'
import { ThemeProvider } from '@/lib/theme'
import {
    build404Html,
    buildAppHtml,
    buildPageHtml,
    buildRobotsTxt,
    buildSitemapXml,
    resolveWebEnv
} from '@/seo/artifacts'
import { seoPageEntries } from '@/seo/pages'
import { renderHtml } from '@/seo/renderHtml'

// Build-time prerender of one marketing page (scripts/render-static.ts). The
// tree is main.tsx's minus the components that only ever render null: the
// client hydrates this HTML, so the two first renders must produce the same
// markup.
export const renderMarketingPage = async (
    path: string,
    language: Language
): Promise<string> => {
    await loadWebLanguage(language)
    setLanguage(language)
    return renderHtml(
        <StrictMode>
            <I18nProvider initialLanguage={language}>
                <AnalyticsConsentBanner />
                <AppAuthProvider>
                    <ThemeProvider>
                        <FontSizeProvider>
                            <StaticRouter location={path}>
                                <App />
                            </StaticRouter>
                        </FontSizeProvider>
                    </ThemeProvider>
                </AppAuthProvider>
            </I18nProvider>
        </StrictMode>
    )
}

// The hashes are only known after the client build, so the preload tags are
// resolved from the emitted assets. Every page gets the regular and semibold
// latin Geist; marketing pages also get the display face their H1 is set in.
const APP_FONTS = [
    /^geist-latin-400-normal-.*\.woff2$/,
    /^geist-latin-600-normal-.*\.woff2$/
]
const MARKETING_FONTS = [...APP_FONTS, /^fraunces-latin-full-normal-.*\.woff2$/]

const fontPreloadTags = (assets: string[], patterns: RegExp[]): string =>
    patterns
        .map((pattern) => assets.find((name) => pattern.test(name)))
        .filter((name): name is string => Boolean(name))
        .map(
            (name) =>
                `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${name}" />`
        )
        .join('\n        ')

interface ManifestChunk {
    file: string
    css?: string[]
    imports?: string[]
}

// The stylesheets a lazy marketing route's chunk brings, its static imports
// included, minus the entry's own: Vite links those only when the chunk
// loads, and a prerendered page has to paint with them.
const routeStylesheets = (
    manifest: Record<string, ManifestChunk>,
    module: string | undefined
): string[] => {
    const key = Object.keys(manifest).find(
        (name) => name === module || name.endsWith(`/${module}`)
    )
    if (!module || !key) return []
    const entryCss = new Set(manifest['index.html']?.css ?? [])
    const seen = new Set<string>()
    const css = new Set<string>()
    const walk = (name: string): void => {
        if (seen.has(name)) return
        seen.add(name)
        for (const file of manifest[name]?.css ?? [])
            if (!entryCss.has(file)) css.add(file)
        for (const imported of manifest[name]?.imports ?? []) walk(imported)
    }
    walk(key)
    return [...css]
}

// Post-build step: turns the client build's shell into app.html, 404.html,
// robots.txt, sitemap.xml and one prerendered page per manifest entry.
// Environment awareness comes from VITE_MF_ENV — anything but 'production'
// produces a fully noindexed artifact set. `beforePage` lets the caller
// point the prerender environment at the page about to render.
export const renderStaticPages = async (
    distDir: string,
    beforePage: (path: string) => void = () => {}
): Promise<void> => {
    const env = resolveWebEnv(process.env.VITE_MF_ENV)
    const shell = await readFile(join(distDir, 'index.html'), 'utf8')
    const assets = await readdir(join(distDir, 'assets')).catch(() => [])
    const manifest = JSON.parse(
        await readFile(join(distDir, '.vite/manifest.json'), 'utf8')
    ) as Record<string, ManifestChunk>

    // From the pristine shell, before index.html is overwritten below.
    await writeFile(
        join(distDir, 'app.html'),
        buildAppHtml(shell, fontPreloadTags(assets, APP_FONTS))
    )
    await writeFile(join(distDir, '404.html'), build404Html())
    await writeFile(join(distDir, 'robots.txt'), buildRobotsTxt(env))
    await writeFile(join(distDir, 'sitemap.xml'), buildSitemapXml())

    for (const entry of seoPageEntries()) {
        beforePage(entry.path)
        const stylesheets = routeStylesheets(
            manifest,
            marketingRouteModule(entry.path)
        )
        const html = buildPageHtml(shell, {
            entry,
            bodyHtml: await renderMarketingPage(entry.path, entry.language),
            env,
            preloadTags: [
                fontPreloadTags(assets, MARKETING_FONTS),
                ...stylesheets.map(
                    (file) =>
                        `<link rel="stylesheet" crossorigin href="/${file}" />`
                )
            ].join('\n        ')
        })
        const target =
            entry.path === '/'
                ? join(distDir, 'index.html')
                : join(distDir, entry.path.replace(/\/$/, ''), 'index.html')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, html)
        console.log(`rendered ${entry.path} (${env})`)
    }
    await rm(join(distDir, '.vite'), { recursive: true, force: true })
}
