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
const UTILITY_RE =
    /(?<![\w-])((?:[\w-]+(?:-\[[^\]\s]*\])?:)*)(shadow-focus(?:-inset)?)(?![\w-])/g
const FOCUS_VISIBLE_VARIANTS = new Set([
    'focus-visible',
    'group-focus-visible',
    'peer-focus-visible',
    'has-[:focus-visible]',
    'group-has-[:focus-visible]',
    'peer-has-[:focus-visible]'
])

const splitVariants = (chain: string): string[] => {
    const parts: string[] = []
    let depth = 0
    let current = ''
    for (const char of chain) {
        if (char === '[') depth += 1
        else if (char === ']') depth -= 1
        if (char === ':' && depth === 0) {
            parts.push(current)
            current = ''
        } else current += char
    }
    return parts
}

const transitionsBoxShadow = (text: string): boolean =>
    /(?<![\w-])transition-shadow(?![\w-])/.test(text) ||
    /(?<![\w-])transition-all(?![\w-])/.test(text) ||
    /(?<![\w-])transition-\[[^\]]*box-shadow[^\]]*\]/.test(text)

const parse = (
    file: string,
    text = readFileSync(file, 'utf8')
): ts.SourceFile =>
    ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
    )

const classUnit = (node: ts.Node): ts.Node => {
    let current = node
    while (current.parent) {
        const parent = current.parent
        if (ts.isJsxAttribute(parent) && parent.name.getText() === 'className')
            return parent
        if (ts.isPropertyAssignment(parent)) return parent
        if (ts.isVariableStatement(parent)) return parent
        current = parent
    }
    return current
}

interface Consumer {
    file: string
    line: number
    utility: string
    variants: string[]
    unitText: string
}

const matches = (
    text: string,
    file: string,
    line: number,
    unitText: string
): Consumer[] =>
    [...text.matchAll(UTILITY_RE)].map((match) => ({
        file,
        line,
        utility: `${match[1]}${match[2]}`,
        variants: match[1] ? splitVariants(match[1]) : [],
        unitText
    }))

const collectSource = (file: string): Consumer[] => {
    const text = readFileSync(file, 'utf8')
    if (!text.includes('shadow-focus')) return []
    const source = parse(file, text)
    const found: Consumer[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node))
            found.push(
                ...matches(
                    node.text,
                    relative(srcRoot, file),
                    source.getLineAndCharacterOfPosition(node.getStart()).line +
                        1,
                    classUnit(node).getText()
                )
            )
        ts.forEachChild(node, visit)
    }
    visit(source)
    return found
}

const APPLY_RE = /@apply([^;]*);/g
const collectCss = (file: string): Consumer[] => {
    const text = readFileSync(file, 'utf8')
    return [...text.matchAll(APPLY_RE)].flatMap((rule) =>
        matches(
            rule[1],
            relative(srcRoot, file),
            text.slice(0, rule.index).split('\n').length,
            rule[1]
        )
    )
}

const consumers = [
    ...sourceFiles.flatMap(collectSource),
    ...cssFiles.flatMap(collectCss)
]
const describe = (consumer: Consumer): string =>
    `${consumer.file}:${consumer.line} \`${consumer.utility}\``

test('the scan sees the product focus-shadow call sites', () => {
    assert.notEqual(consumers.length, 0, 'focus-shadow scan found no consumers')
    const files = new Set(consumers.map((consumer) => consumer.file))
    for (const expected of [
        'components/AppShell.tsx',
        'pages/AgentNew/WorkspacePathField.tsx',
        'pages/AgentNew/v1/AgentNewV1.tsx',
        'styles.css'
    ])
        assert.ok(files.has(expected), `scan lost sight of ${expected}`)
})

test('every focus-shadow utility preserves focus-visible semantics', () => {
    const offenders = consumers
        .filter((consumer) => {
            const last = consumer.variants.at(-1)
            return last === undefined || !FOCUS_VISIBLE_VARIANTS.has(last)
        })
        .map(describe)
    assert.deepEqual(
        offenders,
        [],
        `bind focus shadows to a descendant-or-self focus-visible variant, never bare focus or focus-within:\n${offenders.join('\n')}`
    )
})

test('every focus-shadow consumer transitions box-shadow', () => {
    const offenders = consumers
        .filter((consumer) => !transitionsBoxShadow(consumer.unitText))
        .map(describe)
    assert.deepEqual(
        offenders,
        [],
        `focus-shadow consumers must transition box-shadow in the same class unit:\n${offenders.join('\n')}`
    )
})

test('the framework picker does not gate its ring on open state', () => {
    const file = join(srcRoot, 'pages/AgentNew/v1/AgentNewV1.tsx')
    const source = parse(file)
    let className: ts.JsxAttribute | undefined
    const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node)) {
            const controls = node.attributes.properties.find(
                (attribute): attribute is ts.JsxAttribute =>
                    ts.isJsxAttribute(attribute) &&
                    attribute.name.getText() === 'aria-controls' &&
                    attribute.initializer?.getText() ===
                        "'agent-framework-picker'"
            )
            if (controls)
                className = node.attributes.properties.find(
                    (attribute): attribute is ts.JsxAttribute =>
                        ts.isJsxAttribute(attribute) &&
                        attribute.name.getText() === 'className'
                )
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(className, 'framework picker trigger is missing')
    assert.match(className.getText(), /focus-visible:shadow-focus/)

    const offenders: string[] = []
    const inspect = (node: ts.Node): void => {
        if (ts.isConditionalExpression(node)) {
            const whenTrue = node.whenTrue.getText().includes('shadow-focus')
            const whenFalse = node.whenFalse.getText().includes('shadow-focus')
            if (whenTrue !== whenFalse) offenders.push(node.condition.getText())
        }
        if (
            ts.isBinaryExpression(node) &&
            [
                ts.SyntaxKind.AmpersandAmpersandToken,
                ts.SyntaxKind.BarBarToken,
                ts.SyntaxKind.QuestionQuestionToken
            ].includes(node.operatorToken.kind) &&
            node.left.getText().includes('shadow-focus') !==
                node.right.getText().includes('shadow-focus')
        )
            offenders.push(node.getText())
        ts.forEachChild(node, inspect)
    }
    inspect(className)
    assert.deepEqual(
        offenders,
        [],
        `framework picker open-state branch gates its focus ring: ${offenders.join(', ')}`
    )
})

test('both account overlay triggers ignore open state', () => {
    const file = join(srcRoot, 'components/AppShell.tsx')
    const source = parse(file)
    let helper: ts.VariableDeclaration | undefined
    const callSites: ts.JsxAttribute[] = []
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            node.name.getText() === 'accountTriggerClass'
        )
            helper = node
        if (
            ts.isJsxAttribute(node) &&
            node.name.getText() === 'className' &&
            node.initializer?.getText().includes('accountTriggerClass')
        )
            callSites.push(node)
        ts.forEachChild(node, visit)
    }
    visit(source)

    assert.ok(helper, 'AppShell no longer defines accountTriggerClass')
    assert.equal(callSites.length, 2)
    for (const attribute of callSites) {
        const expression =
            attribute.initializer && ts.isJsxExpression(attribute.initializer)
                ? attribute.initializer.expression
                : undefined
        assert.ok(
            expression &&
                ts.isCallExpression(expression) &&
                expression.arguments.length === 1 &&
                [
                    ts.SyntaxKind.TrueKeyword,
                    ts.SyntaxKind.FalseKeyword
                ].includes(expression.arguments[0].kind),
            `account trigger must pass only a layout literal: ${expression?.getText()}`
        )
    }

    const branches: string[] = []
    const collectBranches = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) && node.text.includes('flex'))
            branches.push(node.text)
        ts.forEachChild(node, collectBranches)
    }
    collectBranches(helper)
    assert.equal(branches.length, 2)
    for (const branch of branches) {
        assert.match(branch, /focus-visible:shadow-focus/)
        assert.ok(transitionsBoxShadow(branch))
        assert.deepEqual(
            branch.split(/\s+/).filter((token) => /^bg-/.test(token)),
            []
        )
    }
})
