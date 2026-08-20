import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import tailwindcss from '@tailwindcss/vite'

// Entry points that must land on the docs home live in public/_redirects, not
// here: a static build can only emit a meta-refresh stub for `redirects`, and
// the browser paints that stub before it forwards.
export default defineConfig({
    site: 'https://docs.manyfold.ai',
    integrations: [mdx(), sitemap()],
    vite: { plugins: [tailwindcss()] },
    markdown: {
        shikiConfig: {
            themes: { light: 'github-light', dark: 'github-dark-dimmed' },
            defaultColor: false,
            wrap: true
        }
    },
    server: { port: 3003 },
    devToolbar: { enabled: false }
})
