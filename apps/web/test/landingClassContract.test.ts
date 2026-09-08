import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const srcRoot = join(import.meta.dirname, '../src')

const walk = (dir: string, pattern: RegExp): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) return walk(full, pattern)
        return pattern.test(entry.name) ? [full] : []
    })

const sourceFiles = walk(srcRoot, /\.tsx?$/).sort()
const cssFiles = walk(srcRoot, /\.css$/).sort()

// The landing register namespaces every rule under `lp-`, so the prefix is
// the whole contract: a class the markup asks for that no rule defines is a
// silently unstyled element, not a compile error.
const CLASS_RE = /(?<![\w-])lp-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g
const COMMENT_RE = /\/\*[\s\S]*?\*\//g

interface Reference {
    file: string
    line: number
    className: string
}

// Only `className` values count. `lp-` also namespaces section ids and SVG
// gradient/filter ids (`id='lp-pricing'`, `url(#lp-blur)`), which are
// resolved by the DOM rather than by a stylesheet.
const collectSource = (file: string): Reference[] => {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('lp-')) return []
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
    )
    const found: Reference[] = []
    const visit = (node: ts.Node): void => {
        if (
            ts.isJsxAttribute(node) &&
            node.name.getText() === 'className' &&
            node.initializer
        ) {
            const literals: ts.Node[] = []
            const gather = (inner: ts.Node): void => {
                if (ts.isStringLiteralLike(inner)) literals.push(inner)
                ts.forEachChild(inner, gather)
            }
            gather(node.initializer)
            for (const literal of literals)
                for (const match of (
                    literal as ts.StringLiteralLike
                ).text.matchAll(CLASS_RE))
                    found.push({
                        file: relative(srcRoot, file),
                        line:
                            source.getLineAndCharacterOfPosition(
                                literal.getStart()
                            ).line + 1,
                        className: match[0]
                    })
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return found
}

const defined = new Set(
    cssFiles.flatMap((file) =>
        [
            ...readFileSync(file, 'utf8')
                .replace(COMMENT_RE, '')
                .matchAll(/\.(lp-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g)
        ].map((match) => match[1])
    )
)

const references = sourceFiles.flatMap(collectSource)

test('the scan sees the landing class call sites', () => {
    assert.notEqual(references.length, 0, 'landing class scan found nothing')
    const files = new Set(references.map((reference) => reference.file))
    for (const expected of [
        'pages/Landing.tsx',
        'components/marketing/MarketingNav.tsx'
    ])
        assert.ok(files.has(expected), `scan lost sight of ${expected}`)
    // Pins the gated two-step CTA, whose markup only renders behind the
    // signup gate — the branch the open-source build never enters, and the
    // reason its rules could go missing unnoticed (550f52f).
    const gated = new Set(
        references
            .filter((reference) => reference.className.startsWith('lp-step-'))
            .map((reference) => reference.className)
    )
    assert.deepEqual(
        [...gated].sort(),
        [
            'lp-step-cta',
            'lp-step-cta-arrow',
            'lp-step-cta-badge',
            'lp-step-cta-badge-full',
            'lp-step-cta-badge-num',
            'lp-step-ctas'
        ],
        'the two-step CTA markup changed shape'
    )
})

test('every lp- class the markup asks for has a rule', () => {
    const seen = new Set<string>()
    const orphans = references
        .filter((reference) => !defined.has(reference.className))
        .filter((reference) => {
            if (seen.has(reference.className)) return false
            seen.add(reference.className)
            return true
        })
        .map(
            (reference) =>
                `${reference.file}:${reference.line} \`${reference.className}\``
        )
    assert.deepEqual(
        orphans,
        [],
        `these lp- classes are referenced by markup but defined by no rule — add the rule, or drop the class:\n${orphans.join('\n')}`
    )
})
