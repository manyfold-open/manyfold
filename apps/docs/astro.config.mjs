import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'
import { rehypeHeadingIds } from '@astrojs/markdown-remark'
import { isTrailerHeading } from './src/lib/trailers.ts'

// Heading anchors: hover a heading and a link to its own id appears, so a reader
// can cite one section instead of the whole page. Both reference sites ship it
// (fal on its dates and titles, Replicate on every heading), and this site had
// nothing: a reader wanting to point at one section had to read the address bar.
//
// Written inline rather than adding rehype-autolink-headings, because it is a
// dozen lines and a docs site should not gain a dependency for them. The <a> is
// deliberately empty: the icon is drawn in CSS, so a heading's text stays
// exactly the heading's text for anything extracting it.
//
// rehypeHeadingIds has to run first. It is what gives every heading the slug id
// the TOC already links to, and an anchor has nothing to point at until it has.
const ANCHORED = new Set(['h2', 'h3', 'h4'])

// A changelog entry's headline is the first h2 of its body, because the
// collection's frontmatter has only a version and a date. Both surfaces that
// render an entry now read that headline through changelogTitle() and render it
// themselves: the index as a link to the entry's own page, the entry page as
// its h1. Leaving the h2 in the body would print the same line twice on both.
//
// Dropped here rather than in either component so the two cannot diverge, and
// so the markdown twin, which reads the raw body, keeps the headline it has
// always had.
const rehypeChangelogHeadline = () => (tree, file) => {
    if (!String(file?.path ?? '').includes('/content/changelog/')) return
    const index = tree.children.findIndex(
        (node) => node.type === 'element' && node.tagName === 'h2'
    )
    if (index >= 0) tree.children.splice(index, 1)
    // Lifting what is left by one level. An entry is authored as `##` headline
    // plus `###` sections; the headline is pulled out above to become the h1,
    // which left 36 pages running h1 -> h3 with no h2 between them. No entry in
    // the corpus carries both levels, so the shift cannot collide, and the
    // check-seo heading gate below fails if one ever does.
    const lift = (nodes) => {
        for (const node of nodes) {
            if (node.type !== 'element') continue
            if (node.tagName === 'h3') node.tagName = 'h2'
            else if (node.tagName === 'h4') node.tagName = 'h3'
            if (node.children) lift(node.children)
        }
    }
    lift(tree.children)
}

// A heading's visible text, for the trailer check below. Reads the children it
// has now, which is before this plugin prepends the anchor, and flattens the
// <code> a command heading is wrapped in.
const headingText = (node) =>
    (node.children ?? [])
        .map((child) =>
            child.type === 'text'
                ? child.value
                : child.type === 'element'
                  ? headingText(child)
                  : ''
        )
        .join('')

const rehypeHeadingAnchors = () => (tree, file) => {
    const path = String(file?.path ?? '')
    // The changelog anchors its version chip instead. #v0.23.1 is what the feed
    // and the .md twin publish, and it survives a retitled release; the title's
    // slug does not.
    if (path.includes('/content/changelog/')) return
    const label = path.includes('/content/docs/zh/')
        ? '复制本节链接'
        : 'Copy link to this section'

    const walk = (node) => {
        for (const child of node.children ?? []) {
            if (
                child.type === 'element' &&
                ANCHORED.has(child.tagName) &&
                child.properties?.id &&
                // A navigational trailer gets no anchor: its body is only links
                // out of the page, so there is nothing in it to cite, and
                // nothing anywhere in the build linked one. See src/lib/trailers.ts.
                // The id stays, because the right rail still links it.
                !isTrailerHeading(headingText(child))
            ) {
                child.children.unshift({
                    type: 'element',
                    tagName: 'a',
                    properties: {
                        className: ['docs-heading-anchor'],
                        href: `#${child.properties.id}`,
                        'aria-label': label
                    },
                    children: []
                })
            }
            walk(child)
        }
    }
    walk(tree)
}

// A markdown table is the one block in the corpus that does not fit the
// reading measure. Wrapping it lets the table keep its own width and scroll
// inside a panel, instead of the page scrolling sideways or every cell
// wrapping to a column of single words (see .docs-table in global.css).
//
// A plugin rather than the client script that wraps <pre>: a table's layout is
// what is being fixed, so it has to be right in the HTML the reader gets and
// in the HTML a crawler parses, not one frame later.
const rehypeTableWrap = () => (tree) => {
    const walk = (node) => {
        const children = node.children ?? []
        for (let index = 0; index < children.length; index += 1) {
            const child = children[index]
            if (child.type !== 'element') continue
            if (child.tagName === 'table') {
                children[index] = {
                    type: 'element',
                    tagName: 'div',
                    properties: { className: ['docs-table'], tabIndex: 0 },
                    children: [child]
                }
                continue
            }
            walk(child)
        }
    }
    walk(tree)
}

// Entry points that must land on the docs home live in public/_redirects, not
// here: a static build can only emit a meta-refresh stub for `redirects`, and
// the browser paints that stub before it forwards.
export default defineConfig({
    site: 'https://docs.manyfold.ai',
    integrations: [mdx(), sitemap()],
    vite: { plugins: [tailwindcss()] },
    markdown: {
        rehypePlugins: [
            rehypeHeadingIds,
            rehypeHeadingAnchors,
            rehypeChangelogHeadline,
            rehypeTableWrap
        ],
        shikiConfig: {
            themes: { light: 'github-light', dark: 'github-dark-dimmed' },
            defaultColor: false,
            wrap: true
        }
    },
    server: { port: 3003 },
    devToolbar: { enabled: false }
})
