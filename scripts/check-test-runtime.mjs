import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'manyfold-test-runtime-')
)
const failures = []

// Node #65934 reproduces #64706 with a valid diagnostic frame followed by
// ordinary stdout in one write. This exercises the real runner, without
// changing its internals or depending on incidental pipe coalescing in a suite.
const payloadSource = String.raw`
import { writeFileSync, writeSync } from 'node:fs'
import test from 'node:test'
import { DefaultSerializer } from 'node:v8'

test('framing payload executed', () => {
    writeFileSync(new URL('./payload.witness', import.meta.url), 'executed')
})
const serializer = new DefaultSerializer()
serializer.writeHeader()
serializer.writeValue({
    type: 'test:diagnostic',
    data: { nesting: 0, message: 'framing witness', file: import.meta.filename }
})
const payload = serializer.releaseBuffer()
const length = Buffer.alloc(4)
length.writeUInt32BE(payload.length)
writeSync(1, Buffer.concat([
    Buffer.from([0xff, 0x0f]), length, payload,
    Buffer.from(process.env.MF_TEST_RUNTIME_TAIL)
]))
`
const controlSource = String.raw`
import { writeFileSync } from 'node:fs'
import test from 'node:test'
test('control file executed', () => {
    writeFileSync(new URL('./control.witness', import.meta.url), 'executed')
})
`

try {
    for (const [label, tail] of [
        ['ASCII', '\nOK mv a.txt -> b.txt\n'],
        ['Unicode', '\n\u2713 mv a.txt \u2192 b.txt\n']
    ]) {
        const cwd = path.join(directory, label)
        fs.mkdirSync(cwd)
        fs.writeFileSync(path.join(cwd, 'payload.test.mjs'), payloadSource)
        fs.writeFileSync(path.join(cwd, 'control.test.mjs'), controlSource)
        const env = { ...process.env, MF_TEST_RUNTIME_TAIL: tail }
        delete env.NODE_TEST_CONTEXT
        const result = spawnSync(
            process.execPath,
            [
                '--test',
                '--test-reporter=tap',
                '--test-concurrency=1',
                'payload.test.mjs',
                'control.test.mjs'
            ],
            {
                cwd,
                env,
                encoding: 'utf8',
                maxBuffer: 1024 * 1024,
                // The broken runner can ignore its own timeout and SIGTERM.
                timeout: 10_000,
                killSignal: 'SIGKILL'
            }
        )
        try {
            assert.ifError(result.error)
            assert.equal(result.signal, null)
            assert.equal(result.status, 0, `${label} test runner failed`)
            for (const [counter, value] of Object.entries({
                tests: 2,
                suites: 0,
                pass: 2,
                fail: 0,
                cancelled: 0,
                skipped: 0,
                todo: 0
            })) {
                const lines =
                    result.stdout.match(
                        new RegExp(`^# ${counter} \\d+$`, 'gm')
                    ) ?? []
                assert.deepEqual(lines, [`# ${counter} ${value}`])
            }
            assert.deepEqual(result.stdout.match(/^1\.\.\d+$/gm), ['1..2'])
            for (const name of [
                'framing payload executed',
                'control file executed'
            ])
                assert.match(
                    result.stdout,
                    new RegExp(`^ok \\d+ - ${name}$`, 'm')
                )
            for (const file of ['payload.witness', 'control.witness'])
                assert.equal(
                    fs.readFileSync(path.join(cwd, file), 'utf8'),
                    'executed'
                )
            assert.ok(
                result.stdout.includes(tail.trim()),
                'ordinary stdout was lost'
            )
            console.log(
                `test-runtime: Node ${process.version}, ${label}: two files executed, complete TAP, exit 0`
            )
        } catch (error) {
            failures.push(
                `${label}: ${error.stack}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
            )
        }
    }
} finally {
    fs.rmSync(directory, { recursive: true, force: true })
}

if (failures.length) throw new Error(failures.join('\n'))
