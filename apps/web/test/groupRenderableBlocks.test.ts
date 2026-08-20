import assert from 'node:assert/strict'
import test from 'node:test'
import {
    chatCapabilitiesByFramework,
    type ChatCapabilities
} from '@manyfold/shared'
import {
    groupRenderableBlocks,
    type ActivityRenderable
} from '../src/components/chat/utils/groupRenderableBlocks'
import type {
    RenderableBlock,
    ToolStatus
} from '../src/components/chat/utils/pairToolBlocks'

const fullCapabilities: ChatCapabilities = {
    streaming: true,
    toolCalls: true,
    thinking: true,
    attachments: true,
    multiTurn: true
}

test('groups adjacent activity blocks and splits them from text runs', () => {
    const blocks: RenderableBlock[] = [
        { kind: 'text', block: { type: 'text', text: 'before' } },
        { kind: 'thinking', block: { type: 'thinking', text: 'considering' } },
        tool('call-1', 'Bash', 'completed'),
        { kind: 'text', block: { type: 'text', text: 'after' } },
        tool('call-2', 'Read', 'running')
    ]

    const groups = groupRenderableBlocks(blocks, fullCapabilities)

    assert.deepEqual(
        groups.map((group) => group.kind),
        ['text-run', 'activity-run', 'text-run', 'activity-run']
    )
    assert.equal(groups[1]?.kind, 'activity-run')
    if (groups[1]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.equal(groups[1].summary.steps, 2)
    assert.equal(groups[1].summary.thoughts, 1)
    assert.equal(groups[1].summary.tools, 1)
    assert.equal(groups[1].summary.label, '2 steps · 1 thought · 1 tool')
    assert.equal(groups[1].status, 'completed')
    assert.equal(groups[3]?.kind, 'activity-run')
    if (groups[3]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.equal(groups[3].status, 'running')
})

test('preserves renderable order inside each group', () => {
    const blocks: RenderableBlock[] = [
        tool('call-1', 'Read', 'completed'),
        { kind: 'thinking', block: { type: 'thinking', text: 'next' } },
        tool('call-2', 'Bash', 'completed')
    ]

    const groups = groupRenderableBlocks(blocks, fullCapabilities)

    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.kind, 'activity-run')
    if (groups[0]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.deepEqual(
        groups[0].blocks.map((block) => block.kind),
        ['paired_tool', 'thinking', 'paired_tool']
    )
})

test('skips disabled activity blocks without splitting visible text', () => {
    const blocks: RenderableBlock[] = [
        { kind: 'text', block: { type: 'text', text: 'a' } },
        { kind: 'thinking', block: { type: 'thinking', text: 'hidden' } },
        tool('call-1', 'Bash', 'completed'),
        { kind: 'text', block: { type: 'text', text: 'b' } }
    ]

    const groups = groupRenderableBlocks(blocks, {
        ...fullCapabilities,
        thinking: false,
        toolCalls: false
    })

    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.kind, 'text-run')
    if (groups[0]?.kind !== 'text-run') throw new Error('unreachable')
    assert.deepEqual(
        groups[0].blocks.map((block) =>
            block.kind === 'text' ? block.block.text : ''
        ),
        ['a', 'b']
    )
})

// The real per-framework rows, not a literal: this table is the only
// capability source the chat surfaces read, and hermes's row claimed no
// thinking and no tools while the adapter streamed both — so every hermes
// thought and tool call was persisted and then dropped here, silently (#677).
test('a hermes turn keeps its thinking and tool blocks; an openclaw turn keeps only its tools', () => {
    const blocks: RenderableBlock[] = [
        { kind: 'text', block: { type: 'text', text: 'answer' } },
        { kind: 'thinking', block: { type: 'thinking', text: 'considering' } },
        tool('call-1', 'Bash', 'completed')
    ]

    const hermes = groupRenderableBlocks(
        blocks,
        chatCapabilitiesByFramework.hermes
    )

    assert.deepEqual(
        hermes.map((group) => group.kind),
        ['text-run', 'activity-run']
    )
    if (hermes[1]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.deepEqual(
        hermes[1].blocks.map((block) => block.kind),
        ['thinking', 'paired_tool']
    )

    // openclaw is a framework whose row really does say thinking: false, so
    // this half fails if the gate stops being consulted at all rather than only
    // when hermes regresses.
    const openclaw = groupRenderableBlocks(
        blocks,
        chatCapabilitiesByFramework.openclaw
    )

    assert.deepEqual(
        openclaw.map((group) => group.kind),
        ['text-run', 'activity-run']
    )
    if (openclaw[1]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.deepEqual(
        openclaw[1].blocks.map((block) => block.kind),
        ['paired_tool']
    )
})

test('derives activity status using error, denied, running, completed priority', () => {
    const errorGroup = groupRenderableBlocks(
        [
            tool('call-1', 'Read', 'running'),
            tool('call-2', 'Bash', 'denied'),
            tool('call-3', 'Edit', 'error')
        ],
        fullCapabilities
    )
    const deniedGroup = groupRenderableBlocks(
        [tool('call-1', 'Read', 'running'), tool('call-2', 'Bash', 'denied')],
        fullCapabilities
    )

    assert.equal(errorGroup[0]?.kind, 'activity-run')
    if (errorGroup[0]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.equal(errorGroup[0].status, 'error')
    assert.equal(deniedGroup[0]?.kind, 'activity-run')
    if (deniedGroup[0]?.kind !== 'activity-run') throw new Error('unreachable')
    assert.equal(deniedGroup[0].status, 'denied')
})

const tool = (
    toolCallId: string,
    toolName: string,
    status: ToolStatus
): ActivityRenderable => ({
    kind: 'paired_tool',
    call: {
        type: 'tool_call',
        toolCallId,
        toolName,
        args: {}
    },
    status
})
