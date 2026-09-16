import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runAdapterWire } from './adapter-wire-harness'

for (const file of ['fresh', 'resumed']) {
    for (const resume of [false, true]) {
        test(`actual Gemini 0.54.4 ${file} wire retains tools through ${resume ? 'resume replay' : 'dispatch'}`, async () => {
            const wire = readFileSync(
                join(__dirname, 'fixtures/gemini-cli-0.54.4', file + '.ndjson'),
                'utf8'
            )
            const rows = wire
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
            const call = rows.find((row) => row.type === 'tool_use')
            const result = rows.find((row) => row.type === 'tool_result')
            const { events, calls } = await runAdapterWire('gemini-cli', wire, {
                resume
            })
            assert.deepEqual(
                events.filter(
                    (event) =>
                        event.type === 'tool_call' ||
                        event.type === 'tool_result'
                ),
                [
                    {
                        type: 'tool_call',
                        toolCallId: call.tool_id,
                        toolName: call.tool_name,
                        args: call.parameters
                    },
                    {
                        type: 'tool_result',
                        toolCallId: call.tool_id,
                        result: result.output
                    }
                ]
            )
            assert.equal(events.at(-1)?.type, 'done')
            assert.equal(
                events.filter((event) => event.type === 'raw_source').length,
                rows.length
            )
            assert.equal(calls.length, 1)
            if (resume) assert.equal(calls[0].fromSeq, 12)
        })
    }
}

test('existing Gemini tool aliases still retain their identities and payloads', async () => {
    const wire = [
        {
            type: 'tool_call',
            id: 'id-form',
            name: 'shell',
            args: { command: 'one' }
        },
        { type: 'tool_result', id: 'id-form', result: 'one' },
        {
            type: 'tool_use',
            toolCallId: 'camel-form',
            toolName: 'read',
            input: { path: 'two' }
        },
        { type: 'tool_result', toolCallId: 'camel-form', output: 'two' }
    ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    const { events } = await runAdapterWire('gemini-cli', wire)
    assert.deepEqual(
        events
            .filter((event) => event.type === 'tool_call')
            .map((event) => event.toolCallId),
        ['id-form', 'camel-form']
    )
    assert.deepEqual(
        events
            .filter((event) => event.type === 'tool_result')
            .map((event) => event.result),
        ['one', 'two']
    )
})
