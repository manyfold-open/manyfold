import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

// The chat page follows model settings changed elsewhere (the CLI, another
// client): a stale tab would otherwise run, and save back as the default,
// the model it loaded with. Checked on the source, as the page needs its
// providers to mount.
const chat = ts.createSourceFile(
    'AgentChat.tsx',
    readFileSync(
        new URL('../src/pages/AgentChat.tsx', import.meta.url),
        'utf8'
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
)

const calls = (name: string): ts.CallExpression[] => {
    const found: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === name
        )
            found.push(node)
        ts.forEachChild(node, visit)
    }
    visit(chat)
    return found
}

test('the chat page refetches its model settings when they change', () => {
    const refresh = calls('useResourceRefresh').find(
        (call) =>
            call.arguments[0]?.getText(chat) === "'model-config'" &&
            call.arguments[1]?.getText(chat) === 'agentId'
    )
    assert.ok(refresh, "no useResourceRefresh('model-config', agentId, …)")
})

test('a newer view keeps a model chosen in the tab and not sent yet', () => {
    const [subscription] = calls('subscribeModelConfigViewUpdates')
    assert.ok(subscription)
    assert.match(subscription.getText(chat), /draftFollowsView\(/)
})
