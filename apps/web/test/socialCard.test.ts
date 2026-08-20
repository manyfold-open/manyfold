import test from 'node:test'
import assert from 'node:assert/strict'
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tForLanguage } from '@manyfold/i18n'
import { OG_IMAGE_PATH } from '../src/seo/head'
import {
    ALIAS_FILE,
    ALIAS_LOCALE,
    HERO_KEYS,
    HTML_LANG,
    POSTER_LOCALES,
    POSTER_VERSION,
    RETIRED_CARDS,
    posterCopy,
    posterFile,
    posterHtml,
    taglineLines
} from '../scripts/og/poster'
import type { PosterCopy, PosterLocale } from '../scripts/og/poster'
import { fontsForLocale, sha256 } from '../scripts/og/fonts'
import {
    CARD_FILE,
    GROOVE_Y,
    MIN_FONT_PX,
    posterContractFailures,
    publishedFailures,
    readLock
} from '../scripts/og/contract'
import type { PosterLock, Published } from '../scripts/og/contract'
import {
    APPS,
    GENERATOR_PACKAGE_RELS,
    GENERATOR_RELS,
    LANDING_PAGE,
    LOCK_REL,
    socialAsset,
    socialAssetRel,
    socialDir
} from '../scripts/og/paths'
import type { AppName } from '../scripts/og/paths'
import {
    CANONICAL_BROWSER_VERSION,
    CANONICAL_IMAGE,
    CANONICAL_NODE_PLATFORM,
    CANONICAL_ORIGIN,
    CANONICAL_PLATFORM,
    IMAGE_ENV,
    IMAGE_PLATFORM_ENV,
    makeScratch,
    removeScratch,
    runtimeStamp
} from '../scripts/og/runtime'
import type { ChromiumOrigin } from '../scripts/og/runtime'
import { outputPaths } from '../scripts/og/canonical'

// #625: the card used to hold its own copy of the hero copy and its own idea of
// which fonts and browser produced it. These pin both ends — the copy to the
// catalog, the bytes to poster.lock.json — so a drift on either side is a test
// failure instead of a wrong card nobody notices.

const doctor = (edit: (lock: PosterLock) => void): PosterLock => {
    const lock = structuredClone(readLock())
    edit(lock)
    return lock
}

const shipping = (
    edit: (published: Map<AppName, Map<string, string>>) => void
): Published => {
    const published = new Map(
        APPS.map((app) => [
            app,
            new Map(
                readdirSync(socialDir(app))
                    .filter(
                        (file) => CARD_FILE.test(file) || file === ALIAS_FILE
                    )
                    .map((file) => [
                        file,
                        sha256(readFileSync(socialAsset(app, file)))
                    ])
            )
        ])
    )
    edit(published)
    return published
}

const mentions = (failures: string[], needle: string): void => {
    assert.ok(
        failures.some((failure) => failure.includes(needle)),
        `expected a failure mentioning ${JSON.stringify(needle)}, got ${JSON.stringify(failures, null, 2)}`
    )
}

const failsWith = (lock: PosterLock, needle: string): void => {
    mentions(posterContractFailures(lock), needle)
}

test('poster copy is read from the i18n catalog, per locale', () => {
    for (const locale of POSTER_LOCALES) {
        const copy = posterCopy(locale)
        for (const key of HERO_KEYS) {
            assert.equal(copy[key], tForLanguage(locale, key))
            assert.notEqual(copy[key], key, `${key} is missing from ${locale}`)
            assert.ok(copy[key].length > 0)
        }
    }
    const en = posterCopy('en')
    const zh = posterCopy('zh')
    for (const key of HERO_KEYS)
        assert.notEqual(
            en[key],
            zh[key],
            `${key} is identical in both catalogs, so the zh card cannot be proven localised`
        )
})

test('the card mirrors keys the landing hero actually renders', () => {
    const landing = readFileSync(LANDING_PAGE, 'utf8')
    for (const key of HERO_KEYS)
        assert.ok(
            landing.includes(`'${key}'`),
            `${key} is on the card but not on the landing page it is a still of`
        )
})

test('the html carries the catalog copy in the page language', () => {
    for (const locale of POSTER_LOCALES) {
        const copy = posterCopy(locale)
        const html = posterHtml({ locale, copy, styles: '' })
        assert.ok(html.includes(`<html lang="${HTML_LANG[locale]}">`))
        assert.ok(html.includes(copy['web.landing.heroTitleBefore']))
        assert.ok(
            html.includes(
                `<span class="p-accent">${copy['web.landing.heroTitleAccent']}</span>`
            )
        )
        assert.ok(!html.includes('{{'), 'a placeholder was left unfilled')
    }
})

test('copy is escaped into the html', () => {
    const copy: PosterCopy = {
        'web.landing.heroTitleBefore': 'a & b',
        'web.landing.heroTitleAfter': '<script>',
        'web.landing.heroTitleAccent': '"quoted"',
        'web.landing.heroTagline': 'x < y, y > z'
    }
    const html = posterHtml({ locale: 'en', copy, styles: '' })
    assert.ok(html.includes('a &amp; b'))
    assert.ok(html.includes('&lt;script&gt;'))
    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('x &lt; y,<br />y &gt; z'))
})

test('the tagline breaks at its last clause boundary', () => {
    assert.deepEqual(taglineLines('one, two'), ['one,', 'two'])
    assert.deepEqual(taglineLines('一，二'), ['一，', '二'])
    assert.deepEqual(taglineLines('one, two, three'), ['one, two,', 'three'])
    assert.deepEqual(taglineLines('no clauses here'), ['no clauses here'])
    assert.deepEqual(taglineLines('trailing,'), ['trailing,'])
    for (const locale of POSTER_LOCALES)
        assert.equal(
            taglineLines(posterCopy(locale)['web.landing.heroTagline']).length,
            2,
            `the ${locale} tagline no longer sets as two lines`
        )
})

test('only the zh card pays for the CJK faces', () => {
    const families = (locale: PosterLocale): string[] =>
        fontsForLocale(locale).map((pin) => pin.family)
    assert.ok(!families('en').includes('Noto Sans SC'))
    assert.ok(families('zh').includes('Noto Sans SC'))
    for (const locale of POSTER_LOCALES)
        assert.ok(families(locale).includes('Geist'))
})

test('seo head points at the locked cards', () => {
    for (const locale of POSTER_LOCALES)
        assert.equal(OG_IMAGE_PATH[locale], `/social/${posterFile(locale)}`)
})

test('the committed cards satisfy the deterministic contract', () => {
    assert.deepEqual(posterContractFailures(), [])
})

test('the locked layout stays clear of the title pill', () => {
    const lock = readLock()
    for (const locale of POSTER_LOCALES) {
        assert.ok(lock.locales[locale].layout.bodyBottom <= GROOVE_Y)
        assert.ok(lock.locales[locale].layout.minFontPx >= MIN_FONT_PX)
    }
})

test('the contract fails when hero copy drifts from the catalog', () => {
    failsWith(
        doctor((lock) => {
            lock.locales.en.copy['web.landing.heroTagline'] = 'yesterday'
        }),
        'stale copy for web.landing.heroTagline'
    )
    for (const key of HERO_KEYS)
        failsWith(
            doctor((lock) => {
                lock.locales.zh.copy[key] = `${lock.locales.zh.copy[key]}!`
            }),
            `stale copy for ${key}`
        )
})

test('the contract fails when the art sources change under the cards', () => {
    failsWith(
        doctor((lock) => {
            lock.template = '0'.repeat(64)
        }),
        'poster.template.html changed'
    )
    failsWith(
        doctor((lock) => {
            lock.css = '0'.repeat(64)
        }),
        'poster.css changed'
    )
    failsWith(
        doctor((lock) => {
            lock.locales.zh.fonts = lock.locales.zh.fonts.slice(0, 1)
        }),
        'different faces than fonts.ts pins now'
    )
    failsWith(
        doctor((lock) => {
            lock.locales.en.fonts[0].sha256 = '0'.repeat(64)
        }),
        'different faces than fonts.ts pins now'
    )
    failsWith(
        doctor((lock) => {
            lock.generator['apps/web/scripts/og/render.ts'] = '0'.repeat(64)
        }),
        'apps/web/scripts/og/render.ts changed'
    )
    failsWith(
        doctor((lock) => {
            delete lock.generator[GENERATOR_RELS[0]]
        }),
        'fingerprints a different generator source set'
    )
    failsWith(
        doctor((lock) => {
            lock.toolchain.playwright = '0.0.0'
        }),
        'but the cards were shot with 0.0.0'
    )
    failsWith(
        doctor((lock) => {
            delete lock.toolchain[
                Object.keys(
                    GENERATOR_PACKAGE_RELS
                )[0] as keyof typeof GENERATOR_PACKAGE_RELS
            ]
        }),
        'fingerprints a different generator toolchain'
    )
})

test('the contract fails when the committed bytes are not the locked bytes', () => {
    failsWith(
        doctor((lock) => {
            lock.locales.en.sha256 = '0'.repeat(64)
        }),
        'is not the card poster.lock.json records'
    )
    failsWith(
        doctor((lock) => {
            lock.locales.zh.file = 'manyfold-og-zh-v9.png'
        }),
        'is missing'
    )
    failsWith(
        doctor((lock) => {
            lock.alias.locale = 'zh'
        }),
        `${ALIAS_FILE} is not the current zh card`
    )
})

test('the contract fails when the pages and the cards name different files', () => {
    failsWith(
        doctor((lock) => {
            lock.locales.en.file = 'manyfold-og-v9.png'
        }),
        'points at a different set of cards'
    )
    failsWith(
        doctor((lock) => {
            lock.version = 'v9'
        }),
        'poster.lock.json is version v9'
    )
    failsWith(
        doctor((lock) => {
            lock.alias.file = 'manyfold-og-old.png'
        }),
        `the long-lived name is ${ALIAS_FILE}`
    )
})

test('the committed cards were shot in the canonical runtime', () => {
    const renderer = readLock().renderer
    assert.equal(renderer.runtime, 'container')
    assert.equal(renderer.image, CANONICAL_IMAGE)
    assert.equal(renderer.imagePlatform, CANONICAL_PLATFORM)
    assert.equal(renderer.platform, CANONICAL_NODE_PLATFORM)
    assert.equal(renderer.browserVersion, CANONICAL_BROWSER_VERSION)
    assert.equal(renderer.origin, CANONICAL_ORIGIN)
    assert.match(
        CANONICAL_IMAGE,
        /@sha256:[0-9a-f]{64}$/,
        'the canonical image must be pinned by manifest digest: a tag is mutable, so a tag-pinned golden is not reproducible'
    )
})

test('the contract fails when the cards came from another runtime', () => {
    failsWith(
        doctor((lock) => {
            lock.renderer.runtime = 'host'
            lock.renderer.image = null
            lock.renderer.imagePlatform = null
            lock.renderer.origin = 'CHROME'
            lock.renderer.platform = 'darwin/arm64'
        }),
        'did not come from the canonical renderer'
    )
    failsWith(
        doctor((lock) => {
            lock.renderer.image = 'mcr.microsoft.com/playwright:v1.60.0-noble'
        }),
        'did not come from the canonical renderer'
    )
    failsWith(
        doctor((lock) => {
            lock.renderer.imagePlatform = 'linux/arm64'
        }),
        'were shot on linux/arm64'
    )
    failsWith(
        doctor((lock) => {
            lock.renderer.platform = 'darwin/arm64'
        }),
        'were shot on linux/amd64 (darwin/arm64)'
    )
    failsWith(
        doctor((lock) => {
            lock.renderer.browserVersion = '149.0.0.1'
        }),
        'were shot with Chromium 149.0.0.1'
    )
    failsWith(
        doctor((lock) => {
            lock.renderer.origin = 'system'
        }),
        'were shot with Chromium from system'
    )
})

test('the contract fails when the lock covers less than the card ships', () => {
    failsWith(
        doctor((lock) => {
            lock.apps = ['web']
        }),
        'covers web, but the card ships in docs, web'
    )
    failsWith(
        doctor((lock) => {
            const locales = lock.locales as unknown as Record<string, unknown>
            locales.fr = locales.en
        }),
        'covers en, fr, zh'
    )
    failsWith(
        doctor((lock) => {
            lock.alias.locale = 'zh'
        }),
        'aliases the zh card'
    )
})

test('the alias is the english card', () => {
    assert.equal(ALIAS_LOCALE, 'en')
    assert.equal(readLock().alias.file, ALIAS_FILE)
})

test('retired cards stay published, byte for byte, in every app', () => {
    const published = shipping(() => {})
    const current = new Set<string>([
        ...POSTER_LOCALES.map(posterFile),
        ALIAS_FILE
    ])
    const retired = [...(published.get('web')?.keys() ?? [])].filter(
        (file) => !current.has(file)
    )
    assert.deepEqual(publishedFailures(published), [])
    assert.ok(
        retired.length > 0,
        `nothing older than ${POSTER_VERSION} is published, so a client holding a retired card's URL has nothing to fetch`
    )
    assert.deepEqual(
        [...retired].sort(),
        Object.keys(RETIRED_CARDS).sort(),
        'the retired freeze in poster.ts and the retired art on disk are different sets'
    )
    mentions(
        publishedFailures(
            shipping((tree) => {
                tree.get('docs')?.delete(retired[0])
            })
        ),
        `${retired[0]} is missing`
    )
    mentions(
        publishedFailures(
            shipping((tree) => {
                tree.get('docs')?.set(retired[0], '0'.repeat(64))
            })
        ),
        `${retired[0]} differs between apps`
    )
    mentions(
        publishedFailures(
            shipping((tree) => {
                for (const files of tree.values())
                    files.delete(posterFile('zh'))
            })
        ),
        `no app publishes ${posterFile('zh')}`
    )
})

// The rule the cross-app parity check cannot state: a retired URL keeps the
// bytes it was published with. Two apps that agree on a rewrite agree on a lie.
test('a retired card cannot be rewritten, even in both apps at once', () => {
    const rewritten = shipping((tree) => {
        for (const files of tree.values())
            for (const file of Object.keys(RETIRED_CARDS))
                files.set(file, '1'.repeat(64))
    })
    const failures = publishedFailures(rewritten)
    assert.ok(
        !failures.some((failure) => failure.includes('differs between apps')),
        'parity is blind to a rewrite both apps agree on, which is why the freeze exists'
    )
    for (const file of Object.keys(RETIRED_CARDS))
        for (const app of APPS)
            mentions(
                failures,
                `apps/${app}/public/social/${file} is not the bytes it was retired with`
            )
    mentions(failures, `retired:  ${RETIRED_CARDS['manyfold-og-v2.png']}`)
})

test('the freeze covers every retired card, in every app', () => {
    const first = Object.keys(RETIRED_CARDS)[0]
    mentions(
        publishedFailures(
            shipping((tree) => {
                for (const files of tree.values()) files.delete(first)
            })
        ),
        `apps/docs/public/social/${first} is missing`
    )
    mentions(
        publishedFailures(
            shipping(() => {}),
            {
                ...RETIRED_CARDS,
                'manyfold-og-v1.png': '2'.repeat(64)
            }
        ),
        'apps/web/public/social/manyfold-og-v1.png is missing'
    )
})

test('a published version is either current or frozen', () => {
    mentions(
        publishedFailures(
            shipping((tree) => {
                for (const files of tree.values())
                    files.set('manyfold-og-zh-v1.png', '3'.repeat(64))
            })
        ),
        'manyfold-og-zh-v1.png is published, is not the current v3 card, and is not ' +
            'in the retired freeze in apps/web/scripts/og/poster.ts'
    )
    mentions(
        publishedFailures(
            shipping((tree) => {
                for (const files of tree.values())
                    files.set('manyfold-og-zh-v1.png', '3'.repeat(64))
            })
        ),
        `add it to RETIRED_CARDS: 'manyfold-og-zh-v1.png': '${'3'.repeat(64)}'`
    )
})

test('the current version cannot be listed as retired', () => {
    mentions(
        publishedFailures(
            shipping(() => {}),
            {
                ...RETIRED_CARDS,
                [posterFile('en')]: '4'.repeat(64)
            }
        ),
        `the retired freeze in poster.ts covers ${posterFile('en')}, which the card still ships as ${POSTER_VERSION}`
    )
})

test('a render brings home the current cards and nothing else', () => {
    const outputs = outputPaths()
    assert.deepEqual(
        [...outputs].sort(),
        [
            LOCK_REL,
            ...APPS.flatMap((app) =>
                [...POSTER_LOCALES.map(posterFile), ALIAS_FILE].map((file) =>
                    socialAssetRel(app, file)
                )
            )
        ].sort()
    )
    for (const rel of outputs)
        assert.ok(
            !rel.startsWith('/') && !rel.split('/').includes('..'),
            `${rel} is not a path inside the repository`
        )
    const current = new Set<string>([
        ...POSTER_LOCALES.map(posterFile),
        ALIAS_FILE
    ])
    for (const [app, files] of shipping(() => {}))
        for (const file of files.keys())
            if (!current.has(file))
                assert.ok(
                    !outputs.includes(socialAssetRel(app, file)),
                    `a render would rewrite ${file}, a retired card clients cached by URL`
                )
})

// runtimeStamp is what writes the claim checkRuntime later enforces, so it is
// tested directly rather than only through a lock that happens to be canonical.
const NODE_PLATFORM = `${process.platform}/${process.arch}`
const ON_CANONICAL_NODE = NODE_PLATFORM === CANONICAL_NODE_PLATFORM
const HOST_STAMP = { runtime: 'host', image: null, imagePlatform: null }

const AMBIENT_PROVENANCE = [IMAGE_ENV, IMAGE_PLATFORM_ENV].map(
    (key) => [key, process.env[key]] as const
)

const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
}

const withProvenance = (
    env: { image?: string; imagePlatform?: string },
    run: () => void
): void => {
    try {
        setEnv(IMAGE_ENV, env.image)
        setEnv(IMAGE_PLATFORM_ENV, env.imagePlatform)
        run()
    } finally {
        for (const [key, value] of AMBIENT_PROVENANCE) setEnv(key, value)
    }
}

const provenanceRestored = (): void => {
    for (const [key, value] of AMBIENT_PROVENANCE)
        assert.equal(process.env[key], value, `${key} leaked out of a case`)
}

const CANONICAL_ENV = {
    image: CANONICAL_IMAGE,
    imagePlatform: CANONICAL_PLATFORM
}

test('a render that announces nothing is stamped host', () => {
    withProvenance({}, () => {
        assert.deepEqual(runtimeStamp({ origin: CANONICAL_ORIGIN }), HOST_STAMP)
        assert.deepEqual(runtimeStamp({ origin: 'system' }), HOST_STAMP)
    })
    provenanceRestored()
})

test('CHROME is host whatever the provenance variables claim', () => {
    withProvenance(CANONICAL_ENV, () => {
        assert.deepEqual(runtimeStamp({ origin: 'CHROME' }), HOST_STAMP)
    })
    withProvenance({ image: 'anything', imagePlatform: 'anything' }, () => {
        assert.deepEqual(runtimeStamp({ origin: 'CHROME' }), HOST_STAMP)
    })
    provenanceRestored()
})

test(
    'the exact canonical provenance stamps container',
    {
        skip: ON_CANONICAL_NODE
            ? false
            : `node reports ${NODE_PLATFORM}, not the canonical ${CANONICAL_NODE_PLATFORM}`
    },
    () => {
        withProvenance(CANONICAL_ENV, () => {
            assert.deepEqual(runtimeStamp({ origin: CANONICAL_ORIGIN }), {
                runtime: 'container',
                image: CANONICAL_IMAGE,
                imagePlatform: CANONICAL_PLATFORM
            })
        })
    }
)

test(
    'a canonical claim from a host that is not linux/x64 is refused',
    {
        skip: ON_CANONICAL_NODE
            ? `node reports the canonical ${CANONICAL_NODE_PLATFORM}`
            : false
    },
    () => {
        withProvenance(CANONICAL_ENV, () => {
            assert.throws(
                () => runtimeStamp({ origin: CANONICAL_ORIGIN }),
                new RegExp(`node reports ${NODE_PLATFORM}, not linux/x64`)
            )
        })
    }
)

// The defect this replaces: any non-empty pair was taken at face value and
// written into the lock as provenance.
test('provenance that is partial, or wrong, is refused rather than recorded', () => {
    const refuses = (
        origin: ChromiumOrigin,
        env: { image?: string; imagePlatform?: string },
        why: RegExp
    ): void => {
        withProvenance(env, () => {
            assert.throws(() => runtimeStamp({ origin }), why)
        })
    }
    refuses(
        CANONICAL_ORIGIN,
        { image: CANONICAL_IMAGE },
        new RegExp(
            `${IMAGE_PLATFORM_ENV} is \\(unset\\), not ${CANONICAL_PLATFORM}`
        )
    )
    refuses(
        CANONICAL_ORIGIN,
        { imagePlatform: CANONICAL_PLATFORM },
        new RegExp(`${IMAGE_ENV} is \\(unset\\), not `)
    )
    refuses(
        CANONICAL_ORIGIN,
        { ...CANONICAL_ENV, image: CANONICAL_IMAGE.split('@')[0] },
        new RegExp(`${IMAGE_ENV} is "${CANONICAL_IMAGE.split('@')[0]}", not `)
    )
    refuses(
        CANONICAL_ORIGIN,
        { ...CANONICAL_ENV, imagePlatform: 'linux/arm64' },
        new RegExp(`${IMAGE_PLATFORM_ENV} is "linux/arm64"`)
    )
    refuses(
        'system',
        CANONICAL_ENV,
        new RegExp(
            `Chromium came from system, not the ${CANONICAL_ORIGIN} build`
        )
    )
    provenanceRestored()
})

// The `.trim()` this replaces: the variables were normalised before they were
// compared, so ` <canonical> ` — a string the recipe never sets — matched, and
// a runtime nobody had declared got its bytes stamped canonical. Asserted on
// the verbatim value because the refusal has to show the padding it tripped on,
// or it reads as `X is <canonical>, not <canonical>`.
test('provenance padded with whitespace is refused, not trimmed into matching', () => {
    const reports = (
        env: { image?: string; imagePlatform?: string },
        key: string,
        value: string
    ): void => {
        let refusal = ''
        withProvenance(env, () => {
            try {
                runtimeStamp({ origin: CANONICAL_ORIGIN })
            } catch (error) {
                refusal = error instanceof Error ? error.message : String(error)
            }
        })
        assert.ok(
            refusal.includes(`${key} is ${JSON.stringify(value)}, not `),
            `${key}=${JSON.stringify(value)} was not refused verbatim: ${refusal || 'it stamped instead'}`
        )
    }
    const paddedImage = ` ${CANONICAL_IMAGE} `
    const paddedPlatform = `\t${CANONICAL_PLATFORM}\n`
    reports({ ...CANONICAL_ENV, image: paddedImage }, IMAGE_ENV, paddedImage)
    reports(
        { ...CANONICAL_ENV, imagePlatform: paddedPlatform },
        IMAGE_PLATFORM_ENV,
        paddedPlatform
    )
    // Whitespace is a value, not an absence: this pair announces something, so
    // it cannot fall through to the host stamp the silent cases take.
    reports({ image: ' ', imagePlatform: ' ' }, IMAGE_ENV, ' ')
    provenanceRestored()
})

// Set-but-empty is the one non-canonical pair that stays host: it is what a
// shell exporting a variable it has nothing to put in leaves behind, and it
// announces no more than an unset variable does.
test('provenance set to empty strings is still an honest host render', () => {
    withProvenance({ image: '', imagePlatform: '' }, () => {
        assert.deepEqual(runtimeStamp({ origin: CANONICAL_ORIGIN }), HOST_STAMP)
    })
    provenanceRestored()
})

test('scratch cleanup refuses anything it did not create', () => {
    const scratch = makeScratch()
    const bystander = mkdtempSync(path.join(realpathSync(tmpdir()), 'not-og-'))
    const nested = mkdtempSync(path.join(scratch, 'mf-og-'))
    try {
        assert.equal(path.dirname(scratch), realpathSync(tmpdir()))
        assert.equal(removeScratch(bystander), false)
        assert.ok(existsSync(bystander), 'a foreign temp dir was removed')
        assert.equal(removeScratch(nested), false)
        assert.ok(existsSync(nested), 'a dir below the temp root was removed')
        assert.equal(removeScratch(path.join(tmpdir(), 'mf-og-gone')), false)
        assert.equal(removeScratch(scratch), true)
        assert.ok(!existsSync(scratch))
    } finally {
        rmSync(bystander, { recursive: true, force: true })
        rmSync(scratch, { recursive: true, force: true })
    }
})
