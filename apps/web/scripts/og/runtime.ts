import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// #625's second half is that the same source produced different pixels on
// different machines. Pinning the fonts and the browser build was not enough:
// the raster comes out of the OS text backend the browser is linked against, so
// the OS has to be pinned too. The committed cards therefore have exactly one
// producer — this image, on this platform — and `just og-render` runs it by
// default rather than shooting from whatever the contributor happens to have.
//
// By manifest digest, not by tag and not by the multi-arch index digest
// (sha256:9bd26ad9…e946b948): a tag is mutable, and an index digest still lets
// an arm64 machine and an amd64 machine answer to the same name with different
// rasterisers, which is the defect rather than the fix.
export const CANONICAL_IMAGE =
    'mcr.microsoft.com/playwright:v1.60.0-noble@sha256:83192064c7510f7ee73dd63dc5f22a5e01a92c81a2e6a9c715d9e3fe55471fd9'

export const CANONICAL_PLATFORM = 'linux/amd64'

// What node reports from inside that image. Docker and node do not share an
// architecture vocabulary, and the lock records both.
export const CANONICAL_NODE_PLATFORM = 'linux/x64'

// The Chromium that digest ships. Addressing the image by manifest digest is
// what makes this a declared input rather than an observation: the same digest
// cannot come back with another build, so a lock naming a different one did not
// come out of the canonical runtime whatever its image field claims.
export const CANONICAL_BROWSER_VERSION = '148.0.7778.96'

// Inside the image, Playwright's own download is present and wins the search in
// render.ts. A system Chromium answering instead means the container is not the
// one this file names.
export const CANONICAL_ORIGIN = 'playwright'

// Set by the host recipe on the container it launched, and read back by the
// renderer so a render has to say which runtime it is in rather than have it
// assumed. A claim to check against the constants above, never a value to copy
// into the lock: see runtimeStamp.
export const IMAGE_ENV = 'MF_OG_IMAGE'
export const IMAGE_PLATFORM_ENV = 'MF_OG_IMAGE_PLATFORM'

export const CANONICAL_RECIPE = 'just og-render'
export const CANONICAL_VERIFY_RECIPE = 'just og-verify'

export type ChromiumOrigin = 'CHROME' | 'playwright' | 'system'

export interface RuntimeStamp {
    runtime: 'container' | 'host'
    image: string | null
    imagePlatform: string | null
}

const HOST: RuntimeStamp = { runtime: 'host', image: null, imagePlatform: null }

// Quoted, because the match is exact: a value differing from the constant only
// by padding would otherwise be reported as identical to the thing it is not.
const given = (value: string | undefined): string =>
    value === undefined ? '(unset)' : JSON.stringify(value)

// The lock says which runtime shot the cards, and the browser-free contract
// check requires that to be the canonical one. `container` is claimed only for
// a run that matches this file exactly — the pinned image, its platform, the
// architecture node reports inside it, and Playwright's own Chromium — and the
// stamp records the constants it matched rather than the strings it was handed.
//
// The variables are set by the recipe on the container it launched, so a render
// that carries them and does not match them is not a weaker claim to write
// down, it is a wrong one. It fails here instead. That still leaves the lock a
// receipt for an honest pipeline rather than a sandbox: `just og-verify` is
// what actually re-derives the bytes.
export const runtimeStamp = (choice: {
    origin: ChromiumOrigin
}): RuntimeStamp => {
    // The documented escape hatch renders for review and never for committing,
    // so it stays `host` even when run inside the canonical image.
    if (choice.origin === 'CHROME') return { ...HOST }
    // Raw. The comparison below is the contract, so a padded value is one that
    // does not match, never one to normalise until it does.
    const image = process.env[IMAGE_ENV]
    const imagePlatform = process.env[IMAGE_PLATFORM_ENV]
    // An ordinary native render announces nothing, and is honestly `host`.
    if (!image && !imagePlatform) return { ...HOST }
    const node = `${process.platform}/${process.arch}`
    const wrong: string[] = []
    if (image !== CANONICAL_IMAGE)
        wrong.push(`${IMAGE_ENV} is ${given(image)}, not ${CANONICAL_IMAGE}`)
    if (imagePlatform !== CANONICAL_PLATFORM)
        wrong.push(
            `${IMAGE_PLATFORM_ENV} is ${given(imagePlatform)}, not ${CANONICAL_PLATFORM}`
        )
    if (node !== CANONICAL_NODE_PLATFORM)
        wrong.push(`node reports ${node}, not ${CANONICAL_NODE_PLATFORM}`)
    if (choice.origin !== CANONICAL_ORIGIN)
        wrong.push(
            `Chromium came from ${choice.origin}, not the ${CANONICAL_ORIGIN} build the image ships`
        )
    if (wrong.length > 0)
        throw new Error(
            'this render claims the canonical runtime and is not it\n' +
                wrong.map((why) => `  ${why}`).join('\n') +
                '\n  refusing to stamp a canonical lock from a runtime that is not one — ' +
                `run \`${CANONICAL_RECIPE}\`, or unset ${IMAGE_ENV}/${IMAGE_PLATFORM_ENV} for an honest host render`
        )
    return {
        runtime: 'container',
        image: CANONICAL_IMAGE,
        imagePlatform: CANONICAL_PLATFORM
    }
}

// Deleting a directory tree from a variable is worth a leash. Everything this
// exporter creates outside the repo lives directly under the system temp dir
// with this prefix; nothing else is ever removed.
const SCRATCH_PREFIX = 'mf-og-'

export const makeScratch = (): string =>
    mkdtempSync(path.join(realpathSync(tmpdir()), SCRATCH_PREFIX))

export const removeScratch = (dir: string): boolean => {
    let resolved: string
    try {
        resolved = realpathSync(dir)
    } catch {
        return false
    }
    const base = path.basename(resolved)
    if (
        path.dirname(resolved) !== realpathSync(tmpdir()) ||
        !base.startsWith(SCRATCH_PREFIX) ||
        base === SCRATCH_PREFIX
    ) {
        console.warn(`refusing to remove ${resolved}: not an og scratch dir`)
        return false
    }
    rmSync(resolved, { recursive: true, force: true })
    return true
}
