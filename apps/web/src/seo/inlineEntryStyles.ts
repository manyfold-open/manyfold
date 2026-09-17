import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Only Vite's own local entry styles are eligible. Keep a non-matching
// stylesheet link so lazy-chunk preloads still recognize the dependency
// and cannot append the same global CSS after a route's override styles.
export const inlineEntryStyles = async (
    shell: string,
    distDir: string
): Promise<string> => {
    const tags = [...shell.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
    if (tags.length === 0) throw new Error('Vite entry stylesheet is missing')
    let html = shell
    for (const [tag] of tags) {
        const href = /\bhref="(\/assets\/[a-zA-Z0-9._-]+\.css)"/.exec(tag)?.[1]
        if (!href || /\bmedia=/.test(tag))
            throw new Error('Unsupported Vite entry stylesheet tag')
        const css = await readFile(join(distDir, href.slice(1)), 'utf8')
        html = html.replace(
            tag,
            `<style data-mf-entry-style="${href}">${css.replaceAll(/<\/style/gi, '<\\/style')}</style>\n${tag.replace('<link ', '<link media="not all" ')}`
        )
    }
    return html
}
