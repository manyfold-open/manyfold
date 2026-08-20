import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
    CONTAINMENT_EXIT_CODE,
    containmentPrelude,
    isContainmentExit
} from '../src/containment'

const run = promisify(execFile)

// The guard is shell, so assert it by running it: a TypeScript-only test would
// pass while the generated script silently allowed everything.
const runGuard = async (
    rootPath: string,
    targets: string[]
): Promise<number> => {
    const script = `${containmentPrelude(rootPath, targets)}\nexit 0`
    try {
        await run('bash', ['-c', script])
        return 0
    } catch (err) {
        return (err as { code?: number }).code ?? -1
    }
}

const fixture = async (): Promise<{
    root: string
    outside: string
}> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-contain-'))
    const root = join(base, 'workspace')
    const outside = join(base, 'secrets')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'ok.txt'), 'inside')
    await writeFile(join(outside, 'creds.json'), 'secret')
    return { root, outside }
}

test('a path inside the root passes', async () => {
    const { root } = await fixture()
    assert.equal(await runGuard(root, [join(root, 'ok.txt')]), 0)
})

test('the root itself passes', async () => {
    const { root } = await fixture()
    assert.equal(await runGuard(root, [root]), 0)
})

// this is the whole point: the API's lexical check sees a path inside the root,
// but following the symlink lands outside it
test('a symlink inside the root pointing outside is refused', async () => {
    const { root, outside } = await fixture()
    const link = join(root, 'creds.json')
    await symlink(join(outside, 'creds.json'), link)

    assert.equal(await runGuard(root, [link]), CONTAINMENT_EXIT_CODE)
})

test('a symlinked directory inside the root is refused', async () => {
    const { root, outside } = await fixture()
    await symlink(outside, join(root, 'escape'))

    assert.equal(
        await runGuard(root, [join(root, 'escape', 'creds.json')]),
        CONTAINMENT_EXIT_CODE
    )
})

// symlinks that stay inside the root are normal: framework config directories
// use them, so refusing them all would break existing agents
test('a symlink that stays inside the root passes', async () => {
    const { root } = await fixture()
    await symlink(join(root, 'ok.txt'), join(root, 'alias.txt'))

    assert.equal(await runGuard(root, [join(root, 'alias.txt')]), 0)
})

// an upload creates its destination, so a path that does not exist yet has to be
// judged by its parent
test('a new file in an existing directory inside the root passes', async () => {
    const { root } = await fixture()
    assert.equal(await runGuard(root, [join(root, 'fresh.bin')]), 0)
})

test('a new file under a symlinked directory is refused', async () => {
    const { root, outside } = await fixture()
    await symlink(outside, join(root, 'escape'))

    assert.equal(
        await runGuard(root, [join(root, 'escape', 'fresh.bin')]),
        CONTAINMENT_EXIT_CODE
    )
})

// the API's lexical check has already run at this point, so an unresolvable deep
// path falls through rather than blocking a legitimate nested mkdir
test('a path whose parent does not exist yet falls through', async () => {
    const { root } = await fixture()
    assert.equal(
        await runGuard(root, [join(root, 'a', 'b', 'c', 'new.bin')]),
        0
    )
})

test('every target is checked, not just the first', async () => {
    const { root, outside } = await fixture()
    const link = join(root, 'creds.json')
    await symlink(join(outside, 'creds.json'), link)

    assert.equal(
        await runGuard(root, [join(root, 'ok.txt'), link]),
        CONTAINMENT_EXIT_CODE
    )
})

// a root reached through a symlink (a daemon home under /var on macOS) must not
// make its own children look like escapes
test('a root behind a symlink still accepts its children', async () => {
    const { root } = await fixture()
    const base = await mkdtemp(join(tmpdir(), 'mf-contain-alias-'))
    const aliasRoot = join(base, 'link-to-workspace')
    await symlink(root, aliasRoot)

    assert.equal(await runGuard(aliasRoot, [join(aliasRoot, 'ok.txt')]), 0)
})

// the guard interpolates paths into a shell script, so quoting is load-bearing
test('paths with spaces and shell metacharacters are escaped, not executed', async () => {
    const { root } = await fixture()
    const awkward = join(root, "a b'c$(touch pwned)`whoami`.txt")
    await writeFile(awkward, 'inside')

    assert.equal(await runGuard(root, [awkward]), 0)
    assert.equal(
        existsSync(join(root, 'pwned')),
        false,
        'command substitution inside a path must not run'
    )
})

test('isContainmentExit only matches the sentinel', () => {
    assert.equal(isContainmentExit(CONTAINMENT_EXIT_CODE), true)
    assert.equal(isContainmentExit(0), false)
    assert.equal(isContainmentExit(1), false)
    assert.equal(isContainmentExit(7), false)
})
