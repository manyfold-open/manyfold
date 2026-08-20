import test from 'node:test'
import assert from 'node:assert/strict'
import { spriteWriteFile, writeExec, writeTempPath } from '../src/file-io'
import type { SpritesClient } from '../src/client'
import { SpritesError } from '../src/errors'

// Verified against a real sprite: cancelling an upload tears the exec session
// down too hard for the script's own EXIT trap to run, so the temp file survived
// every aborted transfer. The caller has to discard it with a fresh exec, and
// these assert that it does — on both the "exec threw" and "exec exited non-zero"
// paths, since a cancelled upload can surface either way.
interface Seen {
    script: string
    hadStdin: boolean
}

const client = {} as SpritesClient

const withExec = async (
    impl: (script: string, stdin: unknown, call: number) => Promise<unknown>,
    run: (seen: Seen[]) => Promise<void>
): Promise<void> => {
    const seen: Seen[] = []
    const original = writeExec.execSprite
    let calls = 0
    writeExec.execSprite = (async (
        _client: unknown,
        _name: string,
        opts: { cmd: string[]; stdin?: unknown }
    ) => {
        calls += 1
        seen.push({
            script: opts.cmd.join(' '),
            hadStdin: opts.stdin !== '' && opts.stdin !== undefined
        })
        return impl(opts.cmd.join(' '), opts.stdin, calls)
    }) as typeof writeExec.execSprite
    try {
        await run(seen)
    } finally {
        writeExec.execSprite = original
    }
}

const ok = { exitCode: 0, stdout: 'ok', stderr: '' }

// The write script contains its own `rm -f` trap, so match only the standalone
// cleanup exec rather than any script that mentions the temp path.
const cleanupCalls = (seen: Seen[], absPath: string): Seen[] =>
    seen.filter(
        (s) =>
            s.script.startsWith('bash -c rm -f ') &&
            s.script.includes(writeTempPath(absPath))
    )

test('writeTempPath names the sibling temp file', () => {
    assert.equal(writeTempPath('/w/a.bin'), '/w/a.bin.mf-part')
})

test('a successful write does not run a cleanup exec', async () => {
    await withExec(
        async () => ok,
        async (seen) => {
            await spriteWriteFile(client, 'sprite-1', {
                absPath: '/w/a.bin',
                body: Buffer.from('x')
            })
            assert.equal(seen.length, 1)
            assert.equal(cleanupCalls(seen, '/w/a.bin').length, 0)
        }
    )
})

// this is the staging case: the stdin pump dies together with the client
test('a write whose exec throws still discards the temp file', async () => {
    await withExec(
        async (_script, _stdin, call) => {
            if (call === 1) throw new Error('exec session destroyed')
            return ok
        },
        async (seen) => {
            await assert.rejects(
                () =>
                    spriteWriteFile(client, 'sprite-1', {
                        absPath: '/w/a.bin',
                        body: Buffer.from('x')
                    }),
                /exec session destroyed/
            )
            assert.equal(
                cleanupCalls(seen, '/w/a.bin').length,
                1,
                'a failed write must remove its own temp file'
            )
        }
    )
})

test('a write that exits non-zero discards the temp file', async () => {
    await withExec(
        async (_script, _stdin, call) =>
            call === 1 ? { exitCode: 1, stdout: '', stderr: 'boom' } : ok,
        async (seen) => {
            await assert.rejects(() =>
                spriteWriteFile(client, 'sprite-1', {
                    absPath: '/w/a.bin',
                    body: Buffer.from('x')
                })
            )
            assert.equal(cleanupCalls(seen, '/w/a.bin').length, 1)
        }
    )
})

// the cleanup path is interpolated into a shell command, so a path carrying a
// quote or a substitution must arrive quoted rather than executed
test('the cleanup escapes awkward paths', async () => {
    const awkward = "/w/a b'c$(touch pwned).bin"
    const singleQuoted = (value: string): string =>
        "'" + value.split("'").join("'\\''") + "'"

    await withExec(
        async (_script, _stdin, call) => {
            if (call === 1) throw new Error('gone')
            return ok
        },
        async (seen) => {
            await assert.rejects(() =>
                spriteWriteFile(client, 'sprite-1', {
                    absPath: awkward,
                    body: Buffer.from('x')
                })
            )
            const cleanup = seen[1]
            assert.equal(
                cleanup.script,
                `bash -c rm -f ${singleQuoted(writeTempPath(awkward))}`
            )
        }
    )
})

// the sprite is often unreachable precisely because the write failed; that must
// not replace the real error with a cleanup error
test('a failing cleanup does not mask the original write failure', async () => {
    await withExec(
        async (_script, _stdin, call) => {
            throw new Error(
                call === 1 ? 'exec session destroyed' : 'sprite unreachable'
            )
        },
        async (seen) => {
            await assert.rejects(
                () =>
                    spriteWriteFile(client, 'sprite-1', {
                        absPath: '/w/a.bin',
                        body: Buffer.from('x')
                    }),
                /exec session destroyed/
            )
            assert.equal(seen.length, 2, 'cleanup was attempted')
        }
    )
})

// exit 77 is the containment sentinel: retrying cannot help, so it must surface as
// a permanent error rather than "runtime unavailable"
test('a containment refusal is permanent, not transient', async () => {
    await withExec(
        async (_script, _stdin, call) =>
            call === 1
                ? {
                      exitCode: 77,
                      stdout: '',
                      stderr: 'mf: path escapes file root'
                  }
                : ok,
        async (seen) => {
            await assert.rejects(
                () =>
                    spriteWriteFile(client, 'sprite-1', {
                        absPath: '/w/a.bin',
                        body: Buffer.from('x'),
                        containRoot: '/w'
                    }),
                (err: unknown) =>
                    err instanceof SpritesError &&
                    err.code === 'permanent' &&
                    /path escapes file root/.test(err.message)
            )
            assert.equal(cleanupCalls(seen, '/w/a.bin').length, 1)
        }
    )
})
