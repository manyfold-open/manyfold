import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    buildHermesRebuildShell,
    buildHermesRestoreShell
} from '../src/modules/agents/bootstrap/hermes-shared'

// An in-place hermes version change moves the working checkout aside, runs the
// installer, and drops the old checkout only once the new one runs. A failed
// installer must leave the old one for the restore shell, never nothing.

const stubBin = (dir: string, name: string, body: string): void => {
    const path = join(dir, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
}

const rig = (t: { after: (fn: () => void) => void }) => {
    const root = mkdtempSync(join(tmpdir(), 'mf-hermes-rebuild-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const home = join(root, '.hermes')
    const bin = join(root, 'bin')
    mkdirSync(join(home, 'hermes-agent', 'venv', 'bin'), { recursive: true })
    stubBin(join(home, 'hermes-agent', 'venv', 'bin'), 'hermes', 'echo old')
    mkdirSync(bin)
    stubBin(bin, 'git', 'exit 0')
    const run = (script: string) =>
        spawnSync('bash', ['-c', script], {
            env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
            encoding: 'utf8'
        })
    return { home, bin, run }
}

test('a failed download fails the rebuild and keeps the old checkout', (t) => {
    const { home, bin, run } = rig(t)
    stubBin(bin, 'curl', 'exit 22')
    const rebuild = run(buildHermesRebuildShell('v2026.9.21', home))
    assert.notEqual(rebuild.status, 0)
    assert.ok(existsSync(join(home, 'hermes-agent.bak', 'venv', 'bin', 'hermes')))

    assert.equal(run(buildHermesRestoreShell(home)).status, 0)
    assert.ok(existsSync(join(home, 'hermes-agent', 'venv', 'bin', 'hermes')))
    assert.equal(existsSync(join(home, 'hermes-agent.bak')), false)
})

test('an installer that exits 0 without a checkout fails the rebuild too', (t) => {
    const { home, bin, run } = rig(t)
    stubBin(bin, 'curl', "echo 'exit 0'")
    const rebuild = run(buildHermesRebuildShell('v2026.9.21', home))
    assert.notEqual(rebuild.status, 0)
    assert.ok(existsSync(join(home, 'hermes-agent.bak', 'venv', 'bin', 'hermes')))
})

test('a checkout that runs replaces the old one', (t) => {
    const { home, bin, run } = rig(t)
    // The stub installer lays down a new checkout, as the real one would.
    const app = join(home, 'hermes-agent', 'venv', 'bin')
    stubBin(
        bin,
        'curl',
        `echo 'mkdir -p "${app}" && printf "#!/bin/sh\\necho new\\n" > "${app}/hermes" && chmod 755 "${app}/hermes"'`
    )
    const rebuild = run(buildHermesRebuildShell('v2026.9.21', home))
    assert.equal(rebuild.status, 0, rebuild.stderr)
    assert.equal(existsSync(join(home, 'hermes-agent.bak')), false)
    assert.equal(
        spawnSync(join(app, 'hermes'), { encoding: 'utf8' }).stdout.trim(),
        'new'
    )
})
