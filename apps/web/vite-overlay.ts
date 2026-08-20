import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { Plugin } from 'vite'

// Same-path file override (editions §3.3, the LobeChat mechanism adapted to
// Vite): when MF_WEB_OVERLAY_DIR is set, any module under this app's src/
// resolves to the file at the SAME relative path inside the overlay directory
// when one exists. The cloud build points this at apps/web-cloud/src, whose
// files replace their open-source counterparts (slot components that render
// null here, real pages there). Unset — every open-source build — the plugin
// is completely inert.

export const overlayCandidate = (
    resolved: string,
    baseSrc: string,
    overlaySrc: string
): string | null => {
    const prefix = baseSrc.endsWith(sep) ? baseSrc : baseSrc + sep
    if (!resolved.startsWith(prefix)) return null
    return join(overlaySrc, relative(baseSrc, resolved))
}

const EXTENSION_PROBES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

const probe = (candidate: string): string | null => {
    for (const ext of EXTENSION_PROBES) {
        const withExt = candidate + ext
        if (existsSync(withExt)) return withExt
    }
    return null
}

export const overlayResolver = (
    baseSrc: string,
    overlaySrc: string | undefined
): Plugin => ({
    name: 'mf-edition-overlay',
    enforce: 'pre',
    async resolveId(source, importer, options) {
        if (!overlaySrc) return null
        // Composition-layer workspace packages resolve to source, mirroring
        // the core aliases above; their CJS dist hides named exports from
        // rollup. Generic rule: any @manyfold/<name> bare id whose package
        // exists next to the core ones and is not already aliased.
        const bare = /^@manyfold\/([a-z-]+)$/.exec(source)
        if (bare) {
            const candidate = join(
                baseSrc,
                '..',
                '..',
                '..',
                'packages',
                bare[1],
                'src',
                'index.ts'
            )
            if (existsSync(candidate)) return candidate
        }
        const resolution = await this.resolve(source, importer, {
            ...options,
            skipSelf: true
        })
        if (resolution) {
            const candidate = overlayCandidate(
                resolution.id,
                baseSrc,
                overlaySrc
            )
            if (!candidate) return null
            const hit = probe(candidate)
            // An overlay module that imports its base counterpart (the
            // wrap-and-extend idiom) resolves to the base file, not itself:
            // mapping here would close an import loop on the overlay file.
            if (!hit || hit === importer) return null
            return hit
        }
        // The base tree cannot resolve it at all: an overlay-only module (a
        // cloud page's private helper or asset with no open-source
        // counterpart). Vite still aliases '@/' into the base tree, so the
        // would-be base path maps to the overlay and is probed there.
        if (source.startsWith(baseSrc + '/'))
            return probe(join(overlaySrc, relative(baseSrc, source)))
        return null
    }
})
