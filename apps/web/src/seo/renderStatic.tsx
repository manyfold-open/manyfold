import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLanguage } from '@manyfold/i18n'
import {
    build404Html,
    buildAppHtml,
    buildPageHtml,
    buildRobotsTxt,
    buildSitemapXml,
    resolveWebEnv
} from '@/seo/artifacts'
import { seoPageEntries, type SeoPageEntry } from '@/seo/pages'
import { LandingSnapshot } from '@/seo/LandingSnapshot'
import {
    StaticMarketingHeader,
    StaticMarketingFooter
} from '@/seo/StaticChrome'

// Post-build step (scripts/render-static.ts): turns the vite SPA shell into
// the indexable HTML pages listed in the SEO manifest, plus app.html,
// 404.html, robots.txt and sitemap.xml. Environment awareness comes from
// VITE_MF_ENV — anything but 'production' produces a fully noindexed artifact
// set. Lives under src/ so the JSX gets the automatic runtime and tsc
// type-checks it with the app.

// Landing-critical faces only: regular and semibold latin Geist. The hashes
// are only known after the vite build, so the preload tags are resolved from
// the emitted assets rather than hardcoded.
const PRELOAD_FONT_PATTERNS = [
    /^geist-latin-400-normal-.*\.woff2$/,
    /^geist-latin-600-normal-.*\.woff2$/
]

const fontPreloadTags = async (distDir: string): Promise<string> => {
    let assets: string[]
    try {
        assets = await readdir(join(distDir, 'assets'))
    } catch {
        return ''
    }
    return PRELOAD_FONT_PATTERNS.map((pattern) => {
        const match = assets.find((name) => pattern.test(name))
        return match
            ? `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${match}" />`
            : ''
    })
        .filter(Boolean)
        .join('\n        ')
}

// Every landing rule is scoped under `.landing-root`, so the crawler body
// needs the wrapper the React route renders too. Without it nothing in the
// pre-React paint matches a rule — most visibly the brand <svg>, which has no
// width/height of its own and stretches to its container instead of the 28px
// `.landing-root .lp-brand-mark` gives it.
// Seen on production [2026-08-07]: a viewport-filling logo for the ~80ms
// between first paint and React booting, on every landing load.
export const renderMarketingBody = (entry: SeoPageEntry): string =>
    renderToStaticMarkup(
        <div className='landing-root'>
            <StaticMarketingHeader language={entry.language} />
            <LandingSnapshot entry={entry} />
            <StaticMarketingFooter language={entry.language} />
        </div>
    )

export const renderStaticPages = async (distDir: string): Promise<void> => {
    const env = resolveWebEnv(process.env.VITE_MF_ENV)
    const shell = await readFile(join(distDir, 'index.html'), 'utf8')
    const preloadTags = await fontPreloadTags(distDir)

    // From the pristine shell, before index.html is overwritten below.
    await writeFile(join(distDir, 'app.html'), buildAppHtml(shell, preloadTags))
    await writeFile(join(distDir, '404.html'), build404Html())
    await writeFile(join(distDir, 'robots.txt'), buildRobotsTxt(env))
    await writeFile(join(distDir, 'sitemap.xml'), buildSitemapXml())

    for (const entry of seoPageEntries()) {
        setLanguage(entry.language)
        const html = buildPageHtml(shell, {
            entry,
            bodyHtml: renderMarketingBody(entry),
            env,
            preloadTags
        })
        const target =
            entry.path === '/'
                ? join(distDir, 'index.html')
                : join(distDir, entry.path.replace(/\/$/, ''), 'index.html')
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, html)
        console.log(`rendered ${entry.path} (${env})`)
    }
}
