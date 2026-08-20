import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWriteScript } from '../src/file-io'

// The write script is shell, and what it does when a transfer dies is the whole
// point, so these run it for real: a staging upload that was aborted mid-body
// left its `.mf-part` behind on the agent, which a TypeScript-level test of the
// generated string would never have caught.
interface RunResult {
    exitCode: number | null
}

const runScript = (
    script: string,
    feed: (stdin: NodeJS.WritableStream, kill: () => void) => void
): Promise<RunResult> =>
    new Promise((resolve) => {
        // own process group: signalling bash alone would leave it blocked on the
        // foreground `cat`, whereas the runtime tears down the whole exec session
        const child = spawn('bash', ['-c', script], {
            stdio: ['pipe', 'ignore', 'ignore'],
            detached: true
        })
        child.on('close', (exitCode) => resolve({ exitCode }))
        child.stdin.on('error', () => {})
        feed(child.stdin, () => {
            try {
                process.kill(-child.pid!, 'SIGTERM')
            } catch {
                child.kill('SIGTERM')
            }
        })
    })

const fixture = async (
    name = 'target.bin'
): Promise<{
    dir: string
    dest: string
    part: string
}> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-write-script-'))
    const dest = join(dir, name)
    return { dir, dest, part: `${dest}.mf-part` }
}

// chat keeps the attachment's original filename, so the default macOS
// screenshot name is the everyday shape this destination takes (#538)
const SCREENSHOT_NAME = 'Screenshot 2026-08-05 at 13.51.46.png'

test('a completed write renames into place and leaves no temp file', async () => {
    const { dest, part } = await fixture()
    const script = buildWriteScript({ absPath: dest })

    const { exitCode } = await runScript(script, (stdin) => {
        stdin.end('finished payload')
    })

    assert.equal(exitCode, 0)
    assert.equal(await readFile(dest, 'utf8'), 'finished payload')
    assert.equal(existsSync(part), false)
})

// this is the staging failure: the client hung up mid-body, the shell died before
// `mv`, and the temp file stayed in the workspace forever
test('a write killed mid-body removes its temp file', async () => {
    const { dest, part } = await fixture()
    const script = buildWriteScript({ absPath: dest })

    const { exitCode } = await runScript(script, (stdin, kill) => {
        stdin.write(Buffer.alloc(64 * 1024, 1))
        setTimeout(kill, 150)
    })

    assert.notEqual(exitCode, 0)
    assert.equal(
        existsSync(part),
        false,
        'temp file must not outlive the failure'
    )
    assert.equal(existsSync(dest), false)
})

test('a failed write leaves an existing destination untouched', async () => {
    const { dest, part } = await fixture()
    await writeFile(dest, 'ORIGINAL')
    const script = buildWriteScript({ absPath: dest })

    await runScript(script, (stdin, kill) => {
        stdin.write(Buffer.alloc(64 * 1024, 2))
        setTimeout(kill, 150)
    })

    assert.equal(await readFile(dest, 'utf8'), 'ORIGINAL')
    assert.equal(existsSync(part), false)
})

// the containment guard runs before any bytes are written, and its refusal must
// not leave a temp file either
test('a write refused by the containment guard leaves nothing behind', async () => {
    const { dir, dest, part } = await fixture()
    const script = buildWriteScript({
        absPath: dest,
        containRoot: join(dir, 'elsewhere')
    })

    const { exitCode } = await runScript(script, (stdin) => {
        stdin.end('never written')
    })

    assert.equal(exitCode, 77)
    assert.equal(existsSync(part), false)
    assert.equal(existsSync(dest), false)
})

test('the write script applies an explicit mode', async () => {
    const { dest } = await fixture()
    const script = buildWriteScript({ absPath: dest, mode: '600' })

    await runScript(script, (stdin) => stdin.end('moded'))

    assert.equal(await readFile(dest, 'utf8'), 'moded')
})

// #538: the trap used to nest an already-quoted path inside its own
// single-quoted handler, so a space in the filename ended the handler early and
// the remaining fragments became `trap` signal arguments; `set -e` then killed
// the script before a byte was written
test('a write succeeds when the destination contains spaces', async () => {
    const { dest, part } = await fixture(SCREENSHOT_NAME)
    const script = buildWriteScript({ absPath: dest, mode: '600' })

    const { exitCode } = await runScript(script, (stdin) => {
        stdin.end('screenshot bytes')
    })

    assert.equal(exitCode, 0)
    assert.equal(await readFile(dest, 'utf8'), 'screenshot bytes')
    assert.equal((await stat(dest)).mode & 0o777, 0o600)
    assert.equal(existsSync(part), false)
})

test('a write succeeds when the destination carries quotes and substitutions', async () => {
    const { dest, part } = await fixture("a b'c`d$(touch pwned).png")
    const script = buildWriteScript({ absPath: dest })

    const { exitCode } = await runScript(script, (stdin) => {
        stdin.end('awkward payload')
    })

    assert.equal(exitCode, 0)
    assert.equal(await readFile(dest, 'utf8'), 'awkward payload')
    assert.equal(existsSync(part), false)
    assert.equal(
        existsSync('pwned'),
        false,
        'path content must never run as shell code'
    )
})

test('a spaced write killed mid-body cleans its temp file and spares the destination', async () => {
    const { dest, part } = await fixture(SCREENSHOT_NAME)
    await writeFile(dest, 'ORIGINAL')
    const script = buildWriteScript({ absPath: dest })

    const { exitCode } = await runScript(script, (stdin, kill) => {
        stdin.write(Buffer.alloc(64 * 1024, 3))
        setTimeout(kill, 150)
    })

    assert.notEqual(exitCode, 0)
    assert.equal(existsSync(part), false)
    assert.equal(await readFile(dest, 'utf8'), 'ORIGINAL')
})

test('a containment refusal still exits 77 for a spaced destination', async () => {
    const { dir, dest, part } = await fixture(SCREENSHOT_NAME)
    const script = buildWriteScript({
        absPath: dest,
        containRoot: join(dir, 'elsewhere')
    })

    const { exitCode } = await runScript(script, (stdin) => {
        stdin.end('never written')
    })

    assert.equal(exitCode, 77)
    assert.equal(existsSync(part), false)
    assert.equal(existsSync(dest), false)
})
