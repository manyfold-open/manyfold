import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// Exercise the production callbacks without mounting AgentChat's unrelated
// session, auth and stream providers. The TypeScript AST keeps this tied to
// the actual two Composer entry points and the callback passed to them.
const parse = (path: string): ts.SourceFile =>
    ts.createSourceFile(
        path,
        readFileSync(new URL(path, import.meta.url), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
    )
const chat = parse('../src/pages/AgentChat.tsx')
const composer = parse('../src/components/chat/Composer.tsx')
const nodes = <T extends ts.Node>(
    root: ts.Node,
    select: (node: ts.Node) => node is T
): T[] => {
    const found: T[] = []
    const visit = (node: ts.Node): void => {
        if (select(node)) found.push(node)
        ts.forEachChild(node, visit)
    }
    visit(root)
    return found
}
const callback = nodes(chat, ts.isVariableDeclaration).find(
    (node) => node.name.getText(chat) === 'handleRefreshModelConfig'
)
assert.ok(callback?.initializer && ts.isCallExpression(callback.initializer))
const refreshSource = callback.initializer.arguments[0].getText(chat)
const menu = nodes(composer, ts.isVariableDeclaration).find(
    (node) => node.name.getText(composer) === 'FrameworkModelConfigMenu'
)
assert.ok(menu)
const entryPoints = nodes(menu, ts.isJsxAttribute).filter(
    (node) =>
        ['onClick', 'onAction'].includes(node.name.getText(composer)) &&
        node.initializer?.getText(composer).includes('onRefresh')
)
assert.equal(entryPoints.length, 2)

const compile = (source: string, scope: Record<string, unknown>): unknown => {
    const javascript = ts.transpile(`const callback = (${source})`, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS
    })
    return new Function(
        ...Object.keys(scope),
        javascript + '\nreturn callback'
    )(...Object.values(scope))
}

for (const entry of entryPoints) {
    test(`model refresh ${entry.name.getText(composer)} consumes 400 and permits a successful retry`, async () => {
        const failure = new Error('model provider credentials are unavailable')
        const refreshing: boolean[] = []
        const errors: Array<string | null> = []
        const saved: unknown[] = []
        let reject = true
        let completion: Promise<void> | undefined
        const view = { agentId: 'fixture', framework: 'claude-code' }
        const refresh = compile(refreshSource, {
            agentId: 'fixture',
            modelConfigSourceDraft: 'runtime-local',
            setModelConfigRefreshing: (value: boolean) =>
                refreshing.push(value),
            setError: (value: string | null) => errors.push(value),
            client: {
                agents: {
                    refreshModelConfigModels: async () => {
                        if (reject) throw failure
                        return { view }
                    }
                }
            },
            apiErrorMessage: (error: Error) => error.message,
            writeCachedModelConfigView: (value: unknown) => saved.push(value),
            setModelConfigView: () => {},
            setModelConfigDraft: () => {},
            setModelConfigSourceDraft: () => {},
            draftFromModelConfigView: () => ({})
        }) as (source?: string) => Promise<void>
        assert.ok(
            entry.initializer &&
                ts.isJsxExpression(entry.initializer) &&
                entry.initializer.expression
        )
        const click = compile(entry.initializer.expression.getText(composer), {
            source: 'runtime-local',
            runtimeLocal: true,
            // The account leg of the click is the account hooks' contract,
            // not the model refresh one under test here.
            accountEnabled: false,
            setRefreshingSource: () => {},
            onRefresh: (source?: string) => (completion = refresh(source))
        }) as () => void
        click()
        assert.ok(completion)
        await assert.doesNotReject(completion)
        assert.deepEqual(refreshing, [true, false])
        assert.deepEqual(errors, [null, failure.message])
        assert.deepEqual(saved, [])
        reject = false
        click()
        await completion
        assert.deepEqual(refreshing, [true, false, true, false])
        assert.deepEqual(errors, [null, failure.message, null])
        assert.deepEqual(saved, [view])
    })
}
