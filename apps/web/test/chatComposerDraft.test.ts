import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const srcRoot = join(import.meta.dirname, '../src')
const agentChat = readFileSync(join(srcRoot, 'pages/AgentChat.tsx'), 'utf8')
const composer = readFileSync(
    join(srcRoot, 'components/chat/Composer.tsx'),
    'utf8'
)

const submitBody = (): string => {
    const start = composer.indexOf('const submit = async ()')
    assert.ok(start >= 0, 'Composer.tsx no longer declares submit()')
    const end = composer.indexOf('\n    const openAttachmentPicker', start)
    assert.ok(end > start, 'could not find the end of submit()')
    return composer.slice(start, end)
}

test('the chat composer has a single mount point', () => {
    const composerElements = agentChat.match(/<Composer\b/g) ?? []
    assert.equal(
        composerElements.length,
        1,
        'AgentChat must render one <Composer>: a second element would remount it'
    )
    const callSites = agentChat.match(/renderComposer\(/g) ?? []
    assert.equal(
        callSites.length,
        1,
        'the composer must be rendered from one JSX position — moving it between ' +
            'the empty state and the docked conversation remounts it, and the ' +
            'fresh instance re-seeds the input from the stored draft'
    )
})

test('submit clears the draft before awaiting the send', () => {
    const body = submitBody()
    const cleared = body.indexOf('clearDraft(draftKey)')
    const awaited = body.indexOf('await onSend(')
    assert.ok(cleared >= 0, 'submit() no longer clears the stored draft')
    assert.ok(awaited >= 0, 'submit() no longer awaits onSend()')
    assert.ok(
        cleared < awaited,
        'clearDraft() must run before onSend(): the parent re-renders the chat ' +
            'mid-send, and a stored draft would be read back into the composer'
    )
    assert.ok(
        body.indexOf("setText('')") < awaited,
        'setText() must clear before onSend(): a later reset lands on a stale ' +
            'instance if the composer remounted while the send was in flight'
    )
})
