import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOpenAiRequest } from '../src/modules/openai-compat/openai-chat-completions.service'

test('extracts file parts from the last user message and skips prior turns', () => {
    const parsed = parseOpenAiRequest({
        model: 'agt_x',
        messages: [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'first turn' },
                    {
                        type: 'image_url',
                        image_url: { url: 'data:image/png;base64,AAAA' }
                    }
                ]
            },
            { role: 'assistant', content: 'ok' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'look at these' },
                    {
                        type: 'image_url',
                        image_url: { url: 'https://example.com/a.png' }
                    },
                    {
                        type: 'file',
                        file: {
                            filename: 'r.pdf',
                            file_data: 'data:application/pdf;base64,BBBB'
                        }
                    }
                ]
            }
        ]
    })
    // only the LAST user message's two files; the prior-turn image is skipped
    assert.equal(parsed.files.length, 2)
    assert.deepEqual(parsed.files[0], {
        kind: 'url',
        value: 'https://example.com/a.png'
    })
    assert.equal(parsed.files[1].kind, 'data')
    assert.equal(parsed.files[1].filename, 'r.pdf')
    assert.ok(parsed.prompt.includes('look at these'))
})

test('a file-only message is allowed (empty prompt)', () => {
    const parsed = parseOpenAiRequest({
        model: 'agt_x',
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: 'https://example.com/a.png' }
                    }
                ]
            }
        ]
    })
    assert.equal(parsed.prompt, '')
    assert.equal(parsed.files.length, 1)
})

test('an unknown content part type is rejected', () => {
    assert.throws(() =>
        parseOpenAiRequest({
            model: 'agt_x',
            messages: [
                {
                    role: 'user',
                    content: [{ type: 'input_audio', input_audio: {} }]
                }
            ]
        })
    )
})

test('a fully empty message is still rejected', () => {
    assert.throws(() =>
        parseOpenAiRequest({
            model: 'agt_x',
            messages: [{ role: 'user', content: [] }]
        })
    )
})
