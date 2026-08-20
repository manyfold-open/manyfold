import { resolve } from 'node:path'
import { renderStaticPages } from '../src/seo/renderStatic'

await renderStaticPages(resolve(import.meta.dirname, '../dist'))
