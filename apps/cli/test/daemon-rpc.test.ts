import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { lstat, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
    assertNotSymlinkItself,
    assertRealPathContained,
    ensureUnderAllowedRoot,
    isInsideRoot,
    setDeclaredWorkspaceRoot,
    workspaceEnsureMode,
    FRAMEWORK_HOME_FILES
} from '../src/daemon/rpc'

test('isInsideRoot allows framework root and descendants', () => {
    const root = join(homedir(), '.claude')

    assert.equal(isInsideRoot(root, root), true)
    assert.equal(isInsideRoot(join(root, 'settings.json'), root), true)
})

test('isInsideRoot rejects sibling paths with shared prefixes', () => {
    const home = homedir()

    assert.equal(
        isInsideRoot(join(home, '.claude-backup'), join(home, '.claude')),
        false
    )
    assert.equal(
        isInsideRoot(join(home, '.codex-old'), join(home, '.codex')),
        false
    )
    assert.equal(
        isInsideRoot(
            join(home, '.nca', 'workspaces-old'),
            join(home, '.nca', 'workspaces')
        ),
        false
    )
})

test('workspace.ensure creates only under the declared managed root', () => {
    const home = homedir()

    // ADR-0014: the managed root is whatever the registration declared —
    // a sprite runner declares ~/.manyfold/workspaces, a laptop daemon
    // defaults to its profile's workspaces dir. Nothing else is implicit.
    setDeclaredWorkspaceRoot('/tmp/mf-declared/workspaces')
    try {
        assert.equal(
            workspaceEnsureMode('/tmp/mf-declared/workspaces/agent-1', true),
            'create-managed'
        )
        assert.equal(
            workspaceEnsureMode(
                join(home, '.nca', 'workspaces', 'agent-1'),
                true
            ),
            'register-existing'
        )
        assert.equal(
            workspaceEnsureMode(join(home, 'Code', 'project'), true),
            'register-existing'
        )
        assert.equal(
            workspaceEnsureMode('/tmp/mf-declared/workspaces/project', false),
            'register-existing'
        )
    } finally {
        setDeclaredWorkspaceRoot(null)
    }
})

// ADR-0013: the lexical root check cannot see through symlinks, but every fs call
// in the daemon follows them, so a symlink planted in a workspace used to reach
// anywhere on the user's machine (~/.ssh, another agent's workspace, …)
const daemonFixture = async (): Promise<{
    root: string
    outside: string
}> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-daemon-contain-'))
    const root = join(base, 'workspaces', 'agent-1')
    const outside = join(base, 'private')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'notes.md'), 'inside')
    await writeFile(join(outside, 'id_rsa'), 'secret')
    return { root, outside }
}

test('assertRealPathContained allows real paths inside a root', async () => {
    const { root } = await daemonFixture()

    assert.doesNotThrow(() =>
        assertRealPathContained(join(root, 'notes.md'), [root])
    )
    assert.doesNotThrow(() => assertRealPathContained(root, [root]))
})

test('assertRealPathContained refuses a symlink that escapes the root', async () => {
    const { root, outside } = await daemonFixture()
    const link = join(root, 'id_rsa')
    await symlink(join(outside, 'id_rsa'), link)

    assert.throws(
        () => assertRealPathContained(link, [root]),
        /resolves outside allowed roots/
    )
})

test('assertRealPathContained refuses a new file under a symlinked directory', async () => {
    const { root, outside } = await daemonFixture()
    await symlink(outside, join(root, 'escape'))

    assert.throws(
        () =>
            assertRealPathContained(join(root, 'escape', 'fresh.bin'), [root]),
        /resolves outside allowed roots/
    )
})

test('assertRealPathContained allows a symlink that stays inside the root', async () => {
    const { root } = await daemonFixture()
    await symlink(join(root, 'notes.md'), join(root, 'alias.md'))

    assert.doesNotThrow(() =>
        assertRealPathContained(join(root, 'alias.md'), [root])
    )
})

test('assertRealPathContained allows a file that does not exist yet', async () => {
    const { root } = await daemonFixture()

    assert.doesNotThrow(() =>
        assertRealPathContained(join(root, 'fresh.bin'), [root])
    )
})

// a workspace root behind a symlink (macOS /var, or a user symlinking their
// projects directory) must not reject its own contents
test('assertRealPathContained resolves the roots too', async () => {
    const { root } = await daemonFixture()
    const base = await mkdtemp(join(tmpdir(), 'mf-daemon-alias-'))
    const aliasRoot = join(base, 'alias')
    await symlink(root, aliasRoot)

    assert.doesNotThrow(() =>
        assertRealPathContained(join(aliasRoot, 'notes.md'), [aliasRoot])
    )
})

test('assertRealPathContained accepts any one of several roots', async () => {
    const { root, outside } = await daemonFixture()

    assert.doesNotThrow(() =>
        assertRealPathContained(join(outside, 'id_rsa'), [root, outside])
    )
})

// DAEMON_FEATURE_FS_CLAUDE_USER_CONFIG (#781): ~/.claude.json is a SIBLING of
// the ~/.claude root, so the root scan can never admit it — only the exact
// file may pass, never a lookalike sibling and never through a symlink.

test('the admitted exact files are pinned to the claude user config', () => {
    assert.deepEqual(FRAMEWORK_HOME_FILES, [join(homedir(), '.claude.json')])
})

test('the exact claude user config passes containment; siblings do not', async () => {
    const claudeUserConfig = join(homedir(), '.claude.json')
    const isLink = await lstat(claudeUserConfig).then(
        (s) => s.isSymbolicLink(),
        () => false
    )
    // A developer machine may legitimately symlink its own config; the guard
    // refuses that by design, so only assert admission on a plain/absent file.
    if (!isLink)
        assert.equal(ensureUnderAllowedRoot(claudeUserConfig), claudeUserConfig)
    assert.throws(
        () => ensureUnderAllowedRoot(join(homedir(), '.claude.jsonx')),
        /outside allowed roots/
    )
    assert.throws(
        () => ensureUnderAllowedRoot(join(homedir(), '.claude.json.bak')),
        /outside allowed roots/
    )
})

test('assertNotSymlinkItself admits plain and absent files, refuses links', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mf-exact-file-'))
    const plain = join(base, 'config.json')
    await writeFile(plain, '{}')
    assert.doesNotThrow(() => assertNotSymlinkItself(plain))
    assert.doesNotThrow(() => assertNotSymlinkItself(join(base, 'absent.json')))

    const target = join(base, 'elsewhere.json')
    await writeFile(target, '{}')
    const link = join(base, 'linked.json')
    await symlink(target, link)
    assert.throws(() => assertNotSymlinkItself(link), /is a symlink/)
})

test('assertNotSymlinkItself tolerates symlinked ancestors', async () => {
    // /var on macOS: the parent may resolve elsewhere as long as the final
    // component is a real file.
    const base = await mkdtemp(join(tmpdir(), 'mf-exact-parent-'))
    const realDir = join(base, 'real')
    await mkdir(realDir)
    await writeFile(join(realDir, 'config.json'), '{}')
    const aliasDir = join(base, 'alias')
    await symlink(realDir, aliasDir)
    assert.doesNotThrow(() =>
        assertNotSymlinkItself(join(aliasDir, 'config.json'))
    )
})
