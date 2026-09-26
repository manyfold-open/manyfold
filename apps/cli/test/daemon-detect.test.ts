import test from 'node:test'
import assert from 'node:assert/strict'
import {
    chmodSync,
    closeSync,
    mkdtempSync,
    openSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BINARY_FOR_FRAMEWORK, detectFrameworks } from '../src/daemon/detect'

// Detection runs on every `mf daemon register` and `daemon start`, so one
// framework binary that cannot be executed must cost only its own version.
// A failed exec makes spawn throw instead of emitting 'error': ENOEXEC for a
// 0-byte file under Bun (the shipped daemon) and Node on macOS. Node on Linux
// runs such a file through /bin/sh, so it is also held open for writing, which
// fails the exec with ETXTBSY there.
// Seen on prod [2026-09-26]: a 0-byte herdr did exactly this to the herdr
// probe, and killed every runner start in two sandboxes.
test('a framework binary that cannot be executed is detected without a version, not a failed detection', async () => {
    // Every binary present, so nothing falls through to the login shell and
    // the machine's own CLIs stay out of it.
    const dir = mkdtempSync(join(tmpdir(), 'mfd-bin-'))
    for (const binary of Object.values(BINARY_FOR_FRAMEWORK)) {
        writeFileSync(
            join(dir, binary),
            binary === 'claude' ? '' : '#!/bin/sh\necho "1.2.3"\n'
        )
        chmodSync(join(dir, binary), 0o755)
    }
    const held = openSync(join(dir, 'claude'), 'r+')
    const previous = { PATH: process.env.PATH, HOME: process.env.HOME }
    process.env.PATH = dir
    process.env.HOME = dir
    try {
        const found = await detectFrameworks()
        assert.deepEqual(
            found.find((f) => f.framework === 'claude-code'),
            {
                framework: 'claude-code',
                version: null,
                path: join(dir, 'claude')
            }
        )
        assert.equal(
            found.find((f) => f.framework === 'codex')?.version,
            '1.2.3'
        )
    } finally {
        process.env.PATH = previous.PATH
        process.env.HOME = previous.HOME
        closeSync(held)
        rmSync(dir, { recursive: true, force: true })
    }
})
