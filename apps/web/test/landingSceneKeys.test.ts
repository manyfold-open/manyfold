import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

/* The scrollytelling rail cross-fades five stacked cards, so `.lp-scene`
   defaults to opacity 0 and the scroll loop writes the live opacity and offset
   into inline styles. That loop runs on scroll and on resize — not on render —
   so a card's DOM node has to survive a re-render carrying those styles. A key
   taken from the copy (an eyebrow, a title) changes when the language does:
   React remounts all five cards, the fresh nodes have no inline style, and the
   rail keeps the CSS default.
   Seen on local dev [2026-09-04]: switching the landing page to 简体中文 left
   every `.lp-scene` at opacity 0 — the hero column blank, nav and art intact —
   until the next scroll repainted it. The scenes are fixed in length and
   order, so the map index is the identity these two lists key on. */
const LOOP_DRIVEN = new Set(['lp-scene', 'lp-pdot'])

const src = readFileSync(
    fileURLToPath(
        new URL('../src/components/landing/ScrollyStage.tsx', import.meta.url)
    ),
    'utf8'
)

const file = ts.createSourceFile(
    'ScrollyStage.tsx',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
)

const classesOf = (element: ts.JsxOpeningLikeElement): Set<string> => {
    const tokens = new Set<string>()
    for (const attribute of element.attributes.properties) {
        if (
            !ts.isJsxAttribute(attribute) ||
            !ts.isIdentifier(attribute.name) ||
            attribute.name.text !== 'className' ||
            attribute.initializer === undefined
        )
            continue
        for (const token of attribute.initializer
            .getText(file)
            .split(/[^\w-]+/))
            if (token) tokens.add(token)
    }
    return tokens
}

const indexParamOf = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
        if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
            const param = n.parameters[1]
            if (param && ts.isIdentifier(param.name)) return param.name.text
        }
    }
    return null
}

const cards: Array<{ element: ts.JsxOpeningLikeElement; line: number }> = []
const collect = (node: ts.Node): void => {
    if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        [...classesOf(node)].some((token) => LOOP_DRIVEN.has(token))
    )
        cards.push({
            element: node,
            line:
                file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
        })
    ts.forEachChild(node, collect)
}
collect(file)

test('the landing rail keys its cards by position, not by their copy', () => {
    assert.equal(
        cards.length,
        LOOP_DRIVEN.size,
        `expected one mapped element per ${[...LOOP_DRIVEN].join('/')} class; found ${cards.length}`
    )
    for (const { element, line } of cards) {
        const index = indexParamOf(element)
        assert.ok(
            index !== null,
            `ScrollyStage.tsx:${line}: expected this element inside a map callback with an index`
        )
        const key = element.attributes.properties.find(
            (attribute) =>
                ts.isJsxAttribute(attribute) &&
                ts.isIdentifier(attribute.name) &&
                attribute.name.text === 'key'
        )
        const value =
            key && ts.isJsxAttribute(key) ? key.initializer : undefined
        assert.ok(
            value !== undefined &&
                ts.isJsxExpression(value) &&
                value.expression !== undefined &&
                ts.isIdentifier(value.expression) &&
                value.expression.text === index,
            `ScrollyStage.tsx:${line}: key must be \`${index}\`; a key that changes with the language remounts the card and blanks the rail`
        )
    }
})
