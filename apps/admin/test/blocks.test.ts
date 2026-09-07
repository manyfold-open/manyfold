import assert from 'node:assert/strict'
import test from 'node:test'
import {
    foldBlocks,
    foldedExtrasLabel,
    formatBytes
} from '../src/pages/ChatSessions/blocks'

// The Transcript card reads chat_messages.content_blocks_json — jsonb the
// page did not write. Every case below is a shape that column really holds:
// a plain answer, the interleaved sequence a tool-using turn leaves behind, a
// prompt carrying attachments, and the two malformed shapes nothing forbids.

test('a plain answer folds to its text and nothing else', () => {
    const folded = foldBlocks([
        { type: 'text', text: 'Reading the file' },
        { type: 'text', text: ' now.\n' }
    ])
    assert.equal(
        folded.text,
        'Reading the file now.',
        'the blocks concatenate with no separator — the buffer already split them mid-sentence'
    )
    assert.deepEqual(folded.extras, [])
    assert.equal(foldedExtrasLabel(folded), null)
})

test('a tool-using turn keeps text separate from the trace, in order', () => {
    const folded = foldBlocks([
        { type: 'thinking', text: 'I should look first.' },
        {
            type: 'tool_call',
            toolCallId: 'c1',
            toolName: 'read_file',
            args: { path: 'a.ts' }
        },
        { type: 'tool_result', toolCallId: 'c1', result: 'export const a = 1' },
        { type: 'text', text: 'The file exports `a`.' }
    ])
    assert.equal(
        folded.text,
        'The file exports `a`.',
        'the answer is the text blocks only — thinking is not what the user saw'
    )
    assert.deepEqual(
        folded.extras.map((b) => b.type),
        ['thinking', 'tool_call', 'tool_result'],
        'stream order is preserved so a call still sits next to its result'
    )
    assert.equal(
        foldedExtrasLabel(folded),
        '1 thinking block · 1 tool call · 1 tool result'
    )
})

test('the extras label pluralises and orders known kinds before unknown', () => {
    const folded = foldBlocks([
        { type: 'flux_capacitor', payload: 1 },
        { type: 'tool_call', toolCallId: 'c1', toolName: 't', args: {} },
        { type: 'tool_call', toolCallId: 'c2', toolName: 't', args: {} },
        { type: 'thinking', text: 'hm' }
    ])
    assert.equal(
        foldedExtrasLabel(folded),
        '1 thinking block · 2 tool calls · 1 × flux_capacitor',
        'an unknown kind keeps its raw type rather than getting an invented name'
    )
})

test('a prompt splits attachments out of the trace', () => {
    const folded = foldBlocks([
        { type: 'text', text: 'Review this' },
        {
            type: 'attachment',
            name: 'spec.md',
            path: '/w/spec.md',
            rootId: 'r1',
            contentType: 'text/markdown',
            size: 2148
        },
        {
            type: 'context_ref',
            name: 'src',
            path: '/w/src',
            rootId: 'r1',
            entryType: 'dir'
        },
        {
            type: 'upload',
            uploadId: 'u1',
            name: 'shot.png',
            contentType: 'image/png',
            size: 4096
        }
    ])
    assert.equal(folded.text, 'Review this')
    assert.equal(folded.attachments.length, 1)
    assert.equal(folded.contextRefs.length, 1)
    assert.equal(folded.uploads.length, 1)
    assert.deepEqual(
        folded.extras,
        [],
        'attachments render as chips, so they must not also appear in the trace'
    )
})

test('a non-array column value folds to empty instead of throwing', () => {
    for (const value of [
        { type: 'text', text: 'a single block, not an array' },
        null,
        undefined,
        'text',
        42
    ]) {
        const folded = foldBlocks(value)
        assert.equal(folded.text, '')
        assert.deepEqual(folded.extras, [])
    }
})

test('unusable entries inside the array are skipped, usable ones survive', () => {
    const folded = foldBlocks([
        null,
        {},
        { type: 42 },
        'text',
        { type: 'text' },
        // A non-string `text` is the case worth guarding: Array.join renders
        // undefined and null as '', so only a value like this one can show
        // whether the fold checks the type or just concatenates whatever it
        // was handed.
        { type: 'text', text: 42 },
        { type: 'text', text: 'kept' }
    ])
    assert.equal(
        folded.text,
        'kept',
        'a text block whose text is not a string contributes nothing rather than being stringified into the answer'
    )
    assert.deepEqual(folded.extras, [])
})

test('byte sizes read as sizes, including the ones that cannot', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2148), '2.1 KB')
    assert.equal(formatBytes(4 * 1024 * 1024), '4.0 MB')
    assert.equal(
        formatBytes(Number.NaN),
        '? B',
        'a stored size can be absent or garbage; "NaN B" would read as a real measurement'
    )
    assert.equal(formatBytes(-1), '? B')
})
