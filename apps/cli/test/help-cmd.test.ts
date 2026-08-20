import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_HELP_TOPICS } from '../src/agent-help/helpers'
import { buildProgram } from '../src/program'
import { MF_CLI_VERSION } from '../src/version'

const captureStdout = async (run: () => Promise<unknown>): Promise<string> => {
    const original = process.stdout.write.bind(process.stdout)
    let out = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
        out += String(chunk)
        return true
    }) as typeof process.stdout.write
    try {
        await run()
    } finally {
        process.stdout.write = original
    }
    return out
}

test('mf help --agent prints the entry guide', async () => {
    const program = buildProgram()
    const out = await captureStdout(() =>
        program.parseAsync(['help', '--agent'], { from: 'user' })
    )
    assert.match(out, /agent guide/)
    assert.match(out, /mf help channels --agent/)
    assert.match(out, /channels:read/)
    assert.ok(!out.includes('{{'), 'unresolved placeholder in output')
})

test('mf help channels create --agent --json emits the envelope', async () => {
    const program = buildProgram()
    const out = await captureStdout(() =>
        program.parseAsync(
            ['help', 'channels', 'create', '--agent', '--json'],
            { from: 'user' }
        )
    )
    const envelope = JSON.parse(out)
    assert.equal(envelope.topic, 'channels-create')
    assert.equal(envelope.cliVersion, MF_CLI_VERSION)
    assert.deepEqual(envelope.topics, [...AGENT_HELP_TOPICS])
    assert.ok(envelope.content.length > 0)
})

test('unknown agent topic rejects loudly with suggestions', async () => {
    const program = buildProgram()
    await assert.rejects(
        () => program.parseAsync(['help', 'chan', '--agent'], { from: 'user' }),
        /unknown agent help topic 'chan'.+channels/
    )
})

test('--json without --agent rejects', async () => {
    const program = buildProgram()
    await assert.rejects(
        () => program.parseAsync(['help', '--json'], { from: 'user' }),
        /--json requires --agent/
    )
})

test('mf help without --agent prints program help', async () => {
    const program = buildProgram()
    const out = await captureStdout(() =>
        program.parseAsync(['help'], { from: 'user' })
    )
    assert.match(out, /Usage: mf/)
    assert.match(out, /channels/)
    assert.match(out, /Core commands:/)
    assert.match(out, /Workflow commands:/)
    assert.match(out, /Access and local tools:/)
    assert.match(out, /Examples:\n {2}mf setup/)
    assert.match(out, /Environment:\n {2}MF_API_URL/)
    assert.doesNotMatch(out, /^Commands:/m)
})

test('mf help channels without --agent prints channels help', async () => {
    const program = buildProgram()
    const out = await captureStdout(() =>
        program.parseAsync(['help', 'channels'], { from: 'user' })
    )
    assert.match(out, /Usage: mf channels/)
    assert.doesNotMatch(out, /Core commands:/)
})

test('mf help with an unknown command rejects loudly', async () => {
    const program = buildProgram()
    await assert.rejects(
        () => program.parseAsync(['help', 'unknowncmd'], { from: 'user' }),
        /unknown command 'unknowncmd'/
    )
    await assert.rejects(
        () =>
            program.parseAsync(['help', 'channels', 'bogus'], { from: 'user' }),
        /unknown command 'channels bogus'/
    )
})

test('mf help resolves command aliases for human help', async () => {
    const program = buildProgram()
    const out = await captureStdout(() =>
        program.parseAsync(['help', 'agent-runtimes'], { from: 'user' })
    )
    assert.match(out, /Usage: mf runtime/)
})
