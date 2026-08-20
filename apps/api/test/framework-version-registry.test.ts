import {
    buildManagedPathScript,
    defaultFrameworkRepo,
    frameworkRepoCandidates,
    versionedFrameworks
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { buildManagedShellReconcileScript } from '../src/modules/agent-self/sprite-shell-env.service'
import {
    buildNpmLatestInstallShell,
    buildNpmUpgradeShell,
    frameworkVersionDescriptor
} from '../src/modules/framework-versions/framework-version-registry'

const claudeShell = buildNpmUpgradeShell(
    frameworkVersionDescriptor('claude-code'),
    '2.1.220'
)

// npm 12 blocks claude-code's postinstall under the default allow-scripts
// policy but still exits 0, leaving a 500-byte no-shebang placeholder where
// the native binary belongs (#438). The approval must be scoped to exactly
// this package — a blanket approval would run every dependency's scripts.
test('claude-code install approves only its own install script', () => {
    assert.match(claudeShell, /--allow-scripts=@anthropic-ai\/claude-code /)
    assert.doesNotMatch(claudeShell, /dangerously/)
})

// codex / gemini / openclaw install fine without lifecycle scripts (verified
// on the affected npm-12 sandbox in #438); granting an approval they don't
// need would silently widen what runs on the sandbox.
for (const framework of ['codex', 'gemini-cli', 'openclaw'] as const) {
    test(`${framework} install keeps lifecycle scripts blocked`, () => {
        const shell = buildNpmUpgradeShell(
            frameworkVersionDescriptor(framework),
            '1.2.3'
        )
        assert.doesNotMatch(shell, /allow-scripts/)
    })
}

// `npm install -g` into the shared nvm prefix mutates the tree the live
// ~/.local/bin symlink may already point into, so a failed install used to
// corrupt the working CLI in place — the reason #438's placeholder survived
// retries. Staging into a per-run prefix leaves the live CLI untouched until
// the candidate is proven good.
test('install stages into an isolated prefix, not the shared global prefix', () => {
    assert.match(claudeShell, /npm install -g --prefix "\$staging"/)
    assert.doesNotMatch(claudeShell, /npm config get prefix/)
})

// The production incident signature: npm exits 0 with an unrunnable candidate
// on disk. The only trustworthy signal is the candidate itself reporting the
// requested version — and that must happen before anything PATH-visible
// changes, or "install failed" would mean "CLI destroyed".
test('the candidate must report the exact requested version before commit', () => {
    const validate = claudeShell.indexOf('--version')
    const commit = claudeShell.indexOf('mv -Tf')
    assert.ok(validate !== -1 && commit !== -1)
    assert.ok(validate < commit)
    // the exact assertion reads the staged package's own manifest, not the
    // freeform `--version` text (see below); `--version` still has to run
    assert.match(claudeShell, /\[ "\$installed" = "2\.1\.220" \]/)
    assert.ok(claudeShell.indexOf('$installed') < commit)
})

// `--version` output is per-CLI freeform text. Parsing three numbers out of it
// cannot see a `-rc.1` suffix, so an exact prerelease spec could never be
// accepted, and a CLI printing only its core version would silently satisfy a
// prerelease target. The manifest is the artefact npm actually installed.
test('an exact prerelease spec is verified against the staged manifest', () => {
    const shell = buildNpmUpgradeShell(
        frameworkVersionDescriptor('claude-code'),
        '2.1.220-rc.1'
    )
    assert.match(shell, /@anthropic-ai\/claude-code@2\.1\.220-rc\.1'/)
    assert.match(shell, /\[ "\$installed" = "2\.1\.220-rc\.1" \]/)
    assert.match(shell, /require\('\$manifest'\)\.version/)
    // npm publishes no `v` prefix, so a v-prefixed tag is normalised for both
    // the install spec and the assertion
    const prefixed = buildNpmUpgradeShell(
        frameworkVersionDescriptor('claude-code'),
        'v2.1.220'
    )
    assert.match(prefixed, /@anthropic-ai\/claude-code@2\.1\.220'/)
    assert.match(prefixed, /\[ "\$installed" = "2\.1\.220" \]/)
})

// A future npm changing `npm root -g --prefix` output must not break every
// framework install, so the literal layout stays as a fallback.
test('the manifest lookup falls back to the literal install layout', () => {
    assert.match(claudeShell, /npm root -g --prefix "\$staging"/)
    assert.match(
        claudeShell,
        /\[ -d "\$root_dir" \] \|\| root_dir="\$staging\/lib\/node_modules"/
    )
})

// A dist-tag resolves registry-side so the exact version is unknowable in the
// shell, but an unversioned candidate (the placeholder prints an error, not a
// version) still must never be committed.
test('a latest install still requires the candidate to report some version', () => {
    const shell = buildNpmLatestInstallShell(
        frameworkVersionDescriptor('claude-code')
    )
    assert.match(shell, /@anthropic-ai\/claude-code@latest/)
    assert.match(shell, /\[ -n "\$got" \]/)
    assert.ok(shell.indexOf('--version') < shell.indexOf('mv -Tf'))
})

// ~/.local/bin/<bin> is the PATH-first name every exec resolves through. The
// ONLY line allowed to touch it is the final atomic rename; anything earlier
// would break the running CLI on a failed install.
test('the live PATH name is only touched by the final atomic rename', () => {
    const touching = claudeShell
        .split('\n')
        .filter((line) => line.includes('.local/bin/claude'))
    assert.deepEqual(touching, [
        'mv -Tf "$staging.link" "$HOME/.local/bin/claude"'
    ])
})

// Failed installs must clean their staging copy (claude-code is ~300 MB), and
// the trap must be cleared right after the rename — an EXIT trap that still
// fires after commit would delete the directory the live symlink now points
// into.
test('staging is cleaned on failure and the trap is cleared after commit', () => {
    const trap = claudeShell.indexOf('trap \'rm -rf "$staging"')
    const install = claudeShell.indexOf('npm install')
    const commit = claudeShell.indexOf('mv -Tf')
    const clear = claudeShell.indexOf('trap - EXIT')
    assert.ok(trap !== -1 && trap < install)
    assert.ok(commit !== -1 && clear !== -1 && commit < clear)
})

// Landing the symlink is only half of activation: a sprite whose shells resolve
// the image's global bin first keeps running the old CLI from the terminal, the
// sprite-side runner and a framework tool's child shell (#611). This shell is
// the one touchpoint every affected sprite already has to run, so it is what
// carries the PATH contract to sandboxes that are already provisioned.
test('the install reconciles the managed PATH block after activation', () => {
    assert.ok(claudeShell.includes(buildManagedPathScript()))
    assert.ok(
        claudeShell.indexOf('mv -Tf') <
            claudeShell.indexOf('mf_write_path_block')
    )
    assert.ok(
        buildNpmLatestInstallShell(
            frameworkVersionDescriptor('gemini-cli')
        ).includes(buildManagedPathScript())
    )
})

// The exact-version contract: anything not a bare x.y.z (dist-tags, preview
// builds) is rejected up front, keeping the shell's version-equality check
// sound.
test('a version spec that is not real semver is rejected before any shell is built', () => {
    for (const bad of ['2.1.220 && id', '2.1.220-;id', 'latest', '2.1'])
        assert.throws(
            () =>
                buildNpmUpgradeShell(
                    frameworkVersionDescriptor('claude-code'),
                    bad
                ),
            /invalid version/,
            bad
        )
})

// #611 AC-1: the atomic swap alone does not finish activation. The image ships
// an nvm shim at /.sprite/bin/node that prepends node's own bin dir INSIDE a
// `#!/usr/bin/env node` binary's startup — after every profile has been read —
// so an image-baked CLI of the same name there wins for the framework and for
// every `run_shell_command` child it spawns. The install has to take that name
// away once the candidate is proven, and only then.
for (const framework of ['claude-code', 'codex', 'gemini-cli'] as const) {
    test(`${framework} install neutralises the shadowing entry after the swap`, () => {
        const descriptor = frameworkVersionDescriptor(framework)
        const shell = buildNpmUpgradeShell(descriptor, '1.2.3')
        assert.match(shell, /dirname\(process\.execPath\)/)
        assert.match(shell, /npm prefix -g/)
        assert.ok(shell.indexOf('mv -Tf') < shell.indexOf('mf_unshadow_dir'))
        const named = shell
            .split('\n')
            .filter((line) => line.includes('mf_entry="$mf_dir/'))
        assert.deepEqual(named, [`  mf_entry="$mf_dir/${descriptor.binName}"`])
        assert.match(shell, /if \[ "\$mf_dir" = "\$HOME\/\.local\/bin" \]/)
    })
}

// openclaw is deliberately excluded: its bootstrap activates THROUGH the npm
// global prefix (`ln -sf "$(npm config get prefix)/bin/openclaw"`), so taking
// that entry away would leave the service exec'ing a dangling symlink.
test('openclaw keeps the npm global prefix entry it activates through', () => {
    const shell = buildNpmLatestInstallShell(
        frameworkVersionDescriptor('openclaw')
    )
    assert.doesNotMatch(shell, /mf_unshadow_dir/)
    assert.doesNotMatch(shell, /mf-shadowed/)
})

// A descriptor naming a node toolchain binary would make the install break
// every later npm call on the sprite. It is an internal invariant, so it fails
// where the shell is built rather than silently at runtime.
test('the node toolchain can never be named as a framework binary', () => {
    for (const bin of ['node', 'npm', 'npx', 'corepack'])
        assert.throws(
            () =>
                buildNpmUpgradeShell(
                    {
                        ...frameworkVersionDescriptor('gemini-cli'),
                        binName: bin
                    },
                    '1.2.3'
                ),
            /node toolchain/
        )
})

// Every managed shell file the reconcile touches on an existing sprite is
// reached by the very upgrade #611 and #650 describe, so the legacy-residue
// cleanup rides the same shell as the PATH block (#650: existing sprites heal
// on next touch, without a re-provision).
test('the install carries the full shared-shell reconcile, not just PATH', () => {
    assert.ok(claudeShell.includes(buildManagedShellReconcileScript()))
    assert.ok(
        claudeShell.indexOf('mf_purge_shell_residue') <
            claudeShell.indexOf('mf_write_path_block')
    )
})

test('every generated install shell is valid POSIX sh and bash', () => {
    for (const framework of [
        'claude-code',
        'codex',
        'gemini-cli',
        'openclaw'
    ] as const) {
        const descriptor = frameworkVersionDescriptor(framework)
        for (const shell of [
            buildNpmUpgradeShell(descriptor, '1.2.3'),
            buildNpmLatestInstallShell(descriptor)
        ])
            for (const interpreter of ['bash', 'sh'])
                execFileSync(interpreter, ['-n'], { input: shell })
    }
})

// The descriptor default and the admin picker's first option must name the same
// repository, or an unconfigured platform fetches one repo while the UI offers
// another. Both read the shared candidate list; this pins that they still do.
test('every github descriptor defaults to its first declared candidate', () => {
    for (const framework of versionedFrameworks) {
        const { source } = frameworkVersionDescriptor(framework)
        if (source.kind !== 'github') {
            assert.deepEqual(
                frameworkRepoCandidates(framework),
                [],
                `${framework} is npm-sourced but declares repo candidates`
            )
            continue
        }
        assert.equal(source.repo, defaultFrameworkRepo(framework), framework)
        assert.ok(
            frameworkRepoCandidates(framework).some(
                (c) => c.repo === source.repo
            ),
            `${framework} descriptor repo is not one of its candidates`
        )
    }
})
