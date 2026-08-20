import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildStatScript } from '../src/file-io'

const run = promisify(execFile)

// Run the generated script rather than assert on its text: the bug this covers
// was found on staging, where reading an in-root symlink failed because `stat`
// reported the link's own length (its target path) as the file size and the read
// then short-read against it.
const runStat = async (
    absPath: string,
    containRoot?: string
): Promise<{ exitCode: number; lines: string[] }> => {
    const script = buildStatScript({ absPath, containRoot })
    try {
        const { stdout } = await run('bash', ['-c', script])
        return {
            exitCode: 0,
            lines: stdout.split('\n').filter((l) => l.length > 0)
        }
    } catch (err) {
        return { exitCode: (err as { code?: number }).code ?? -1, lines: [] }
    }
}

const fixture = async (): Promise<{
    root: string
    outside: string
    body: string
}> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-stat-script-'))
    const root = join(base, 'workspace')
    const outside = join(base, 'outside')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    const body = 'INSIDE TARGET\n'
    await writeFile(join(root, 'real.txt'), body)
    return { root, outside, body }
}

test('a plain file reports its own size', async () => {
    const { root, body } = await fixture()
    const { exitCode, lines } = await runStat(join(root, 'real.txt'))

    assert.equal(exitCode, 0)
    assert.equal(Number(lines[0]), body.length)
})

// the staging failure: a link path longer than its target made the read ask for
// more bytes than the file has
test('a symlink reports the size of its target, not of the link', async () => {
    const { root, body } = await fixture()
    const link = join(root, 'a-much-longer-alias-name-than-the-target.txt')
    await symlink(join(root, 'real.txt'), link)

    const { exitCode, lines } = await runStat(link)

    assert.equal(exitCode, 0)
    assert.equal(
        Number(lines[0]),
        body.length,
        'size must describe the target file'
    )
    assert.notEqual(Number(lines[0]), link.length)
})

test('a symlink reports the content type of its target', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'page.html'), '<!doctype html><p>hi')
    const link = join(root, 'alias.html')
    await symlink(join(root, 'page.html'), link)

    const { lines } = await runStat(link)

    assert.ok(
        lines[1]?.includes('html') || lines[1]?.includes('text'),
        `expected a text-ish type, got ${lines[1]}`
    )
})

test('a missing path reports MISSING rather than failing', async () => {
    const { root } = await fixture()
    const { exitCode, lines } = await runStat(join(root, 'nope.txt'))

    assert.equal(exitCode, 0)
    assert.equal(lines[0], 'MISSING')
})

// a dangling link has no target to describe, so it must read as missing rather
// than as a zero-byte file
test('a dangling symlink reports MISSING', async () => {
    const { root } = await fixture()
    const link = join(root, 'dangling.txt')
    await symlink(join(root, 'gone.txt'), link)

    const { exitCode, lines } = await runStat(link)

    assert.equal(exitCode, 0)
    assert.equal(lines[0], 'MISSING')
})

test('the containment guard still refuses a symlink that escapes the root', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const link = join(root, 'escape.txt')
    await symlink(join(outside, 'secret.txt'), link)

    const { exitCode } = await runStat(link, root)

    assert.equal(exitCode, 77)
})

test('the containment guard allows a symlink that stays inside the root', async () => {
    const { root, body } = await fixture()
    const link = join(root, 'inside-alias.txt')
    await symlink(join(root, 'real.txt'), link)

    const { exitCode, lines } = await runStat(link, root)

    assert.equal(exitCode, 0)
    assert.equal(Number(lines[0]), body.length)
})
