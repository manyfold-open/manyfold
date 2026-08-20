import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { repoRoot } from './paths'

// Every face the poster can reach is pinned by content hash and inlined into
// the generated CSS as a data: URL. Two reasons it is not a file:// url like
// the first exporter used: a path that resolves on the author's machine does
// not resolve inside the render container (the repo mounts at a different
// prefix), and a silent miss degrades to a host fallback face rather than
// failing, which is how the same source produced different pixels on two
// supported hosts.
//
// Latin comes from the app's own dependency tree so the card cannot drift from
// the landing page it mirrors. CJK is not a runtime dependency of any app —
// the landing page lets the host supply it — so it is fetched from a version-
// pinned CDN path and cached, rather than adding a 71MB package to every
// install for a script only the card author runs.

export interface FontPin {
    family: string
    weight: number
    sha256: string
    // A workspace dependency, or a pinned upstream file fetched on demand.
    source:
        | { kind: 'package'; file: string }
        | { kind: 'remote'; url: string; cache: string }
}

export const FONT_PINS: readonly FontPin[] = [
    {
        family: 'Geist',
        weight: 400,
        sha256: 'ead637fd0b6b887d829b3ce3f25fdc242b1de0cfb69c0d97987933675d1315ba',
        source: {
            kind: 'package',
            file: '@fontsource/geist/files/geist-latin-400-normal.woff2'
        }
    },
    {
        family: 'Geist',
        weight: 500,
        sha256: '6145bf6706dbc1b6686f04f871489cf724951f00b752745896ccdcac07639a53',
        source: {
            kind: 'package',
            file: '@fontsource/geist/files/geist-latin-500-normal.woff2'
        }
    },
    {
        family: 'Geist Mono',
        weight: 400,
        sha256: '3f98383b122fe015a48536cd4a1cda855a201718923ffe74931a01597107b9b5',
        source: {
            kind: 'package',
            file: '@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2'
        }
    },
    {
        family: 'Noto Sans SC',
        weight: 400,
        sha256: '95e3633b6a98f764ba3adfb54504a0cd4799328c009adf9081d6c1850f9c4c78',
        source: {
            kind: 'remote',
            url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.0/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
            cache: 'noto-sans-sc-chinese-simplified-400-normal.woff2'
        }
    },
    {
        family: 'Noto Sans SC',
        weight: 500,
        sha256: '885f52ca6a25fddde7641eaf9cf6d6fd9e8f1a454f99f77f0f1be1be0c6470a5',
        source: {
            kind: 'remote',
            url: 'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.3.0/files/noto-sans-sc-chinese-simplified-500-normal.woff2',
            cache: 'noto-sans-sc-chinese-simplified-500-normal.woff2'
        }
    }
]

// Latin-only locales do not pay for the 1.1MB CJK faces.
export const LATIN_FAMILIES = ['Geist', 'Geist Mono']

export const fontsForLocale = (locale: 'en' | 'zh'): readonly FontPin[] =>
    locale === 'zh'
        ? FONT_PINS
        : FONT_PINS.filter((pin) => LATIN_FAMILIES.includes(pin.family))

export const sha256 = (bytes: Buffer): string =>
    createHash('sha256').update(bytes).digest('hex')

export const packageFontPath = (pin: FontPin): string => {
    if (pin.source.kind !== 'package')
        throw new Error(`${pin.family} ${pin.weight} is not a package font`)
    return path.join(repoRoot, 'node_modules', pin.source.file)
}

export const FONT_CACHE_ENV = 'MF_OG_FONT_CACHE'

export const fontCacheDir = (): string =>
    process.env[FONT_CACHE_ENV] ??
    path.join(repoRoot, 'apps/web/scripts/og/.fonts')

const readPackageFont = (pin: FontPin): Buffer => {
    const file = packageFontPath(pin)
    try {
        return readFileSync(file)
    } catch {
        throw new Error(
            `missing ${pin.family} ${pin.weight}: ${file}\n` +
                '  run pnpm install first'
        )
    }
}

const readRemoteFont = async (pin: FontPin): Promise<Buffer> => {
    if (pin.source.kind !== 'remote') throw new Error('not a remote font')
    const dir = fontCacheDir()
    const file = path.join(dir, pin.source.cache)
    try {
        return readFileSync(file)
    } catch {
        // Not cached yet. The URL carries an exact package version, and the
        // bytes are hash-checked below, so this cannot silently pick up a
        // different face than the one the committed cards were rendered with.
        const response = await fetch(pin.source.url)
        if (!response.ok)
            throw new Error(
                `could not fetch ${pin.family} ${pin.weight} ` +
                    `(${response.status} ${response.statusText})\n` +
                    `  ${pin.source.url}\n` +
                    `  set MF_OG_FONT_CACHE to a directory holding ${pin.source.cache} to render offline`
            )
        const bytes = Buffer.from(await response.arrayBuffer())
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, bytes)
        return bytes
    }
}

export const loadFont = async (pin: FontPin): Promise<Buffer> => {
    const bytes =
        pin.source.kind === 'package'
            ? readPackageFont(pin)
            : await readRemoteFont(pin)
    const actual = sha256(bytes)
    if (actual !== pin.sha256)
        throw new Error(
            `${pin.family} ${pin.weight} does not match its pin\n` +
                `  expected ${pin.sha256}\n` +
                `  actual   ${actual}\n` +
                '  the face changed: re-render the cards and update FONT_PINS in fonts.ts'
        )
    return bytes
}

export const fontFaceCss = (pin: FontPin, bytes: Buffer): string =>
    [
        '@font-face {',
        `    font-family: '${pin.family}';`,
        `    font-weight: ${pin.weight};`,
        '    font-style: normal;',
        '    font-display: block;',
        `    src: url('data:font/woff2;base64,${bytes.toString('base64')}') format('woff2');`,
        '}'
    ].join('\n')
