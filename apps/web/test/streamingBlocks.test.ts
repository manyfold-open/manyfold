import assert from 'node:assert/strict'
import test from 'node:test'
import {
    appendStreamingBlock,
    streamingBlocksToContentBlocks,
    type StreamingBlock
} from '../src/components/chat/utils/streamingBlocks'

test('keeps token and tool ordering in streaming content blocks', () => {
    const blocks: StreamingBlock[] = [
        { kind: 'token', text: 'Before ' },
        {
            kind: 'tool_call',
            toolCallId: 'tool-1',
            toolName: 'Bash',
            args: { command: 'pwd' }
        },
        {
            kind: 'tool_result',
            toolCallId: 'tool-1',
            result: { output: '/workspace' }
        },
        { kind: 'token', text: ' after.' }
    ]

    const content = streamingBlocksToContentBlocks(blocks)

    assert.deepEqual(
        content.map((block) => block.type),
        ['text', 'tool_call', 'tool_result', 'text']
    )
    assert.equal(content[0]?.type === 'text' ? content[0].text : '', 'Before ')
    assert.equal(content[3]?.type === 'text' ? content[3].text : '', ' after.')
})

test('merges adjacent token chunks before rendering', () => {
    const blocks = appendStreamingBlock(
        appendStreamingBlock([], { kind: 'token', text: 'hel' }),
        { kind: 'token', text: 'lo' }
    )

    assert.deepEqual(blocks, [{ kind: 'token', text: 'hello' }])
    assert.deepEqual(streamingBlocksToContentBlocks(blocks), [
        { type: 'text', text: 'hello' }
    ])
})

test('merges adjacent thinking chunks before rendering', () => {
    const blocks = appendStreamingBlock(
        appendStreamingBlock([], { kind: 'thinking', text: 'plan' }),
        { kind: 'thinking', text: ' step' }
    )

    assert.deepEqual(blocks, [{ kind: 'thinking', text: 'plan step' }])
    assert.deepEqual(streamingBlocksToContentBlocks(blocks), [
        { type: 'thinking', text: 'plan step' }
    ])
})
