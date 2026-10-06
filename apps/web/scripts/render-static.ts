import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { installFirstVisit } from './prerender-environment'
import type * as ServerEntry from '../src/entry-server'

const appDir = resolve(import.meta.dirname, '..')
// The build writes to dist/ and dist-ssr/; a test points both elsewhere.
const { values } = parseArgs({
    options: { dist: { type: 'string' }, ssr: { type: 'string' } }
})
const distDir = resolve(values.dist ?? resolve(appDir, 'dist'))
const ssrDir = resolve(values.ssr ?? resolve(appDir, 'dist-ssr'))

const visit = installFirstVisit()

// Built by `vite build --ssr src/entry-server.tsx` with the same aliases and
// overlay as the client, so a composition's pages render here as they boot
// there.
const server = (await import(
    pathToFileURL(resolve(ssrDir, 'entry-server.js')).href
)) as typeof ServerEntry

await server.renderStaticPages(distDir, visit)
