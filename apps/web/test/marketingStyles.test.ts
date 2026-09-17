import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderStaticPages } from '../src/seo/renderStatic'
import { inlineEntryStyles } from '../src/seo/inlineEntryStyles'

test('marketing HTML carries the complete entry CSS while app.html retains its external stylesheet', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'mf-marketing-styles-'))
    const css =
        '@font-face{font-family:Owned;src:url(/assets/owned.woff2)}.example{color:red}.example:after{content:"</style>"}'
    try {
        await mkdir(join(dist, 'assets'))
        await writeFile(join(dist, 'assets/index-owned.css'), css)
        await writeFile(
            join(dist, 'index.html'),
            '<html lang="en"><head><title>Manyfold</title><link crossorigin rel="stylesheet" href="/assets/index-owned.css"></head><body><div id="root"></div><script type="module" src="/assets/index-owned.js"></script></body></html>'
        )
        await renderStaticPages(dist)
        const marketing = await readFile(join(dist, 'index.html'), 'utf8')
        const app = await readFile(join(dist, 'app.html'), 'utf8')
        assert.ok(
            marketing.includes(
                '<style data-mf-entry-style="/assets/index-owned.css">'
            )
        )
        assert.ok(marketing.includes('src:url(/assets/owned.woff2)'))
        assert.ok(marketing.includes('content:"<\\/style>"'))
        assert.ok(
            marketing.includes(
                '<link media="not all" crossorigin rel="stylesheet"'
            )
        )
        assert.equal((marketing.match(/<\/style>/g) ?? []).length, 1)
        assert.equal(
            await readFile(join(dist, 'assets/index-owned.css'), 'utf8'),
            css
        )
        assert.ok(app.includes('<link crossorigin rel="stylesheet"'))
        assert.ok(!app.includes('data-mf-entry-style'))
        assert.ok(!app.includes('media="not all"'))
    } finally {
        await rm(dist, { recursive: true, force: true })
    }
})

test('entry-style inlining fails closed on missing or non-local build assets', async () => {
    await assert.rejects(
        inlineEntryStyles('<head></head>', '/not-read'),
        /stylesheet is missing/
    )
    await assert.rejects(
        inlineEntryStyles(
            '<link rel="stylesheet" href="https://example.invalid/style.css">',
            '/not-read'
        ),
        /Unsupported/
    )
    await assert.rejects(
        inlineEntryStyles(
            '<link rel="stylesheet" href="/assets/../style.css">',
            '/not-read'
        ),
        /Unsupported/
    )
})
