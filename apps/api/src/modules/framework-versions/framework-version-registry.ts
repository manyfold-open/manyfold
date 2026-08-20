import {
    BUILTIN_BLOCKED_FRAMEWORK_VERSIONS,
    VersionedFramework,
    defaultFrameworkRepo,
    isSemverVersionTag,
    safeNpmVersionSpec
} from '@manyfold/shared'
import { buildManagedShellReconcileScript } from '@/modules/agent-self/sprite-shell-env.service'

// Single source of truth for per-framework version metadata. Today the
// install/pin logic lives scattered across the bootstrap files
// (claude-code.ts, codex.ts, gemini.ts, openclaw-sprite.ts, hermes-sprite.ts,
// narranexus-sprite.ts); this registry centralises the descriptive bits the
// catalog + probe + upgrade paths all need.

export type FrameworkVersionSource =
    | { kind: 'npm'; package: string }
    // repo is `owner/name`; GitHub releases drive the catalog (wired in P3).
    // This is only the DEFAULT — an admin can point a framework at another of
    // its candidates, so read the effective repo from
    // FrameworkVersionsService.repoFor() rather than from here.
    | { kind: 'github'; repo: string }

// The descriptor's default and the admin picker's first option have to be the
// same repository, or an unconfigured platform would fetch one repo while the
// UI claimed another. Taking both from the shared candidate list makes that
// impossible to get wrong; framework-version-registry.test.ts pins it.
const githubSource = (
    framework: VersionedFramework
): FrameworkVersionSource => {
    const repo = defaultFrameworkRepo(framework)
    if (!repo)
        throw new Error(`no repo candidates declared for ${framework}`)
    return { kind: 'github', repo }
}

export interface FrameworkVersionDescriptor {
    framework: VersionedFramework
    // 'coding' = FrameworkBootstrap (no long-running service to restart);
    // 'daemon' = SpriteServiceBootstrap (service must restart after upgrade).
    runtimeKind: 'coding' | 'daemon'
    source: FrameworkVersionSource
    // npm 12's default install-script policy blocks lifecycle scripts while
    // still exiting 0, which leaves a package that REQUIRES its postinstall
    // broken on disk — claude-code's postinstall swaps a placeholder bin for
    // the platform's native binary (#438). Set to pass a package-scoped
    // --allow-scripts for exactly this package; every other package's scripts
    // stay blocked. Verified on npm 12.0.1 + 11.16.0; npms predating the
    // policy run install scripts by default, so there the flag is at worst a
    // warn-and-ignore no-op.
    npmAllowInstallScripts?: boolean
    // the CLI binary name on PATH (differs from the npm package name, e.g.
    // `@anthropic-ai/claude-code` -> `claude`). Used for the ~/.local/bin
    // symlink + version probe.
    binName: string
    // Move an image-baked binary of the same name out of node's own bin dir
    // after activation (see buildUnshadowActivationShell). Set only where this
    // registry owns activation end to end — i.e. `~/.local/bin/<bin>` always
    // points into the staged install below. NOT set for openclaw, whose
    // bootstrap deliberately activates THROUGH the npm global prefix
    // (`ln -sf "$(npm config get prefix)/bin/openclaw"`, openclaw-sprite.ts):
    // displacing that entry would break the symlink the service execs.
    unshadowNodeBinDir?: boolean
    // shell run under `bash -lc` that prints the installed version to stdout.
    // ~/.local/bin is prepended because npm-global bins are not on the default
    // non-interactive PATH (see openclaw-sprite.ts symlink note).
    probeShell: string
    // sprite Services API name to restart after a daemon upgrade
    serviceName?: string
}

const DESCRIPTORS: Record<VersionedFramework, FrameworkVersionDescriptor> = {
    'claude-code': {
        framework: 'claude-code',
        runtimeKind: 'coding',
        source: { kind: 'npm', package: '@anthropic-ai/claude-code' },
        npmAllowInstallScripts: true,
        binName: 'claude',
        unshadowNodeBinDir: true,
        probeShell: 'export PATH="$HOME/.local/bin:$PATH"; claude --version'
    },
    codex: {
        framework: 'codex',
        runtimeKind: 'coding',
        source: { kind: 'npm', package: '@openai/codex' },
        binName: 'codex',
        unshadowNodeBinDir: true,
        probeShell: 'export PATH="$HOME/.local/bin:$PATH"; codex --version'
    },
    'gemini-cli': {
        framework: 'gemini-cli',
        runtimeKind: 'coding',
        source: { kind: 'npm', package: '@google/gemini-cli' },
        binName: 'gemini',
        unshadowNodeBinDir: true,
        probeShell: 'export PATH="$HOME/.local/bin:$PATH"; gemini --version'
    },
    openclaw: {
        framework: 'openclaw',
        runtimeKind: 'daemon',
        source: { kind: 'npm', package: 'openclaw' },
        binName: 'openclaw',
        probeShell: 'export PATH="$HOME/.local/bin:$PATH"; openclaw --version',
        serviceName: 'openclaw'
    },
    hermes: {
        framework: 'hermes',
        runtimeKind: 'daemon',
        source: githubSource('hermes'),
        binName: 'hermes',
        // The installed version is the cloned git tag (CalVer, e.g. v2026.6.5) —
        // NOT `hermes --version`, which reports the decoupled pyproject version
        // (0.x). A `main`-installed agent (shallow, no tags) describes to nothing
        // and reads as "not detected" until upgraded to a tag. Mirrors narranexus.
        probeShell:
            'git -C "$HOME/.hermes/hermes-agent" describe --tags 2>/dev/null || true',
        serviceName: 'hermes'
    },
    narranexus: {
        framework: 'narranexus',
        runtimeKind: 'daemon',
        source: githubSource('narranexus'),
        binName: 'narranexus',
        // narranexus has no CLI; the installed version is the cloned git tag.
        probeShell:
            'git -C "$HOME/.narranexus/app" describe --tags 2>/dev/null || true',
        serviceName: 'narranexus'
    }
}

export const frameworkVersionDescriptor = (
    framework: VersionedFramework
): FrameworkVersionDescriptor => DESCRIPTORS[framework]

export const allFrameworkVersionDescriptors =
    (): FrameworkVersionDescriptor[] => Object.values(DESCRIPTORS)

// Shell (for `bash -lc`) that upgrades an npm-installed coding-agent CLI to an
// exact version, then makes it win on PATH. Verified on the sprite image
// (probe 2026-06-16, reworked for npm 12 2026-07-29 — #438):
//   - The image uses nvm; `npm config set prefix` is REJECTED by nvm and, worse,
//     poisons ~/.npmrc so every later npm call fails. A per-invocation
//     `--prefix` flag persists nothing, so each install stages into its own
//     throwaway prefix instead of mutating nvm's shared global prefix — which
//     the live ~/.local/bin/<bin> symlink may point into from an earlier
//     install, so an in-place `npm install -g` can destroy the working CLI.
//   - npm's exit code proves nothing: npm 12 blocks unapproved install
//     scripts but still exits 0, leaving claude-code's no-shebang placeholder
//     where the native binary belongs. The staged candidate must itself run
//     `--version` and report the expected version BEFORE anything PATH-visible
//     changes.
//   - The image's pre-installed CLI lives at ~/.local/bin/<bin>, which is
//     PATH-first (see openclaw-sprite.ts symlink note). The validated
//     candidate is committed there last, via symlink + `mv -Tf` (atomic
//     rename), so every failure mode leaves the previous CLI runnable —
//     including retries on a sprite whose current install is already broken.
// The caller MUST re-probe and assert the version actually changed (fail loud).
export const buildNpmUpgradeShell = (
    descriptor: FrameworkVersionDescriptor,
    version: string
): string => {
    if (!isSemverVersionTag(version))
        throw new Error(
            `buildCodingUpgradeShell: invalid version "${version}"`
        )
    // Trimmed, for the same reason the clone guards trim: the string that was
    // validated has to be the string that reaches the shell.
    return buildNpmInstallShell(descriptor, version.trim())
}

// Same install path pinned to npm's `latest` dist-tag. Used at bootstrap when
// the platform can't resolve an exact version (catalog empty / registry down)
// AND the sprite image ships no binary at all — better a floating latest than no
// CLI. Prefer buildNpmUpgradeShell whenever a version is known, so the installed
// version is recorded rather than guessed.
//
// This is the one install that cannot consult the catalog, so it is also the one
// that would happily land on a known-broken release (#594: npm's gemini-cli
// `latest` WAS 0.54.0). The built-in denylist is compiled into a semver range
// instead, which npm resolves registry-side — still the newest release, just
// never one inside a bad window. Operator-added windows are deliberately not
// consulted here: this path runs without settings, and the compiled-in list is
// what must survive an unreachable control plane.
export const buildNpmLatestInstallShell = (
    descriptor: FrameworkVersionDescriptor
): string =>
    buildNpmInstallShell(
        descriptor,
        safeNpmVersionSpec(BUILTIN_BLOCKED_FRAMEWORK_VERSIONS[descriptor.framework])
    )

// node's own toolchain. Displacing any of these would break every later npm
// call on the sprite, so a descriptor that ever named one is a bug, not a
// configuration.
const NODE_TOOLCHAIN_BINS = ['node', 'npm', 'npx', 'corepack']

// The last hop of activation, and the one no profile can reach.
//
// The sprite image ships `/.sprite/bin/node`, an nvm activation shim. When the
// activated `~/.local/bin/<bin>` is a `#!/usr/bin/env node` script — gemini-cli
// and codex both are — `env node` finds that shim, and the shim does:
//
//     case ":$PATH:" in *":$NODE_BIN_DIR:"*) ;; *) export PATH="$NODE_BIN_DIR:$PATH" ;; esac
//     exec "$NODE_BIN_DIR/$cmd_name" "$@"
//
// i.e. it prepends node's own bin dir INSIDE the activated binary's startup,
// after every profile has already been read. An image-baked global copy of the
// same CLI living in that dir therefore wins for the CLI itself and for every
// `run_shell_command` child it spawns, and no profile ordering can precede it
// (#611 staging drill: the tool child ran the nvm-global gemini 0.53.0 after a
// successful, verified 0.54.4 upgrade; a second upgrade and a runner restart
// did not heal it).
//
// So make the dir stop competing: once the candidate has proven itself and the
// atomic swap has landed, move the same-named entry aside. Deliberately narrow:
//   - one name — the binary this install just activated — never a package, and
//     never node/npm/npx/corepack;
//   - `mv` aside rather than delete, so `npm install -g <pkg>` restores it and
//     an operator can see what was displaced;
//   - `$HOME/.local/bin` is skipped explicitly, so the activation can never
//     displace itself even if node ever lives there;
//   - absent entry / unwritable dir / no node at all are all no-ops, which is
//     what a fresh image (whose nvm prefix holds only the toolchain) hits.
export const buildUnshadowActivationShell = (bin: string): string => {
    if (NODE_TOOLCHAIN_BINS.includes(bin))
        throw new Error(`refusing to unshadow the node toolchain bin "${bin}"`)
    return [
        'mf_unshadow_dir() {',
        '  mf_dir="$1"',
        '  [ -n "$mf_dir" ] || return 0',
        '  [ -d "$mf_dir" ] || return 0',
        '  if [ "$mf_dir" = "$HOME/.local/bin" ]; then return 0; fi',
        `  mf_entry="$mf_dir/${bin}"`,
        '  [ -e "$mf_entry" ] || [ -L "$mf_entry" ] || return 0',
        '  mv -f "$mf_entry" "$mf_entry.mf-shadowed" 2>/dev/null || true',
        '  return 0',
        '}',
        // `process.execPath` is resolved by the real node the shim execs, so
        // its dirname is exactly $NODE_BIN_DIR — asking node beats parsing
        // `command -v node`, which answers with the shim's own directory.
        `mf_node_bin="$(node -p 'require("path").dirname(process.execPath)' 2>/dev/null || true)"`,
        'mf_npm_prefix="$(npm prefix -g 2>/dev/null || true)"',
        'mf_unshadow_dir "$mf_node_bin"',
        'if [ -n "$mf_npm_prefix" ]; then mf_unshadow_dir "$mf_npm_prefix/bin"; fi'
    ].join('\n')
}

const buildNpmInstallShell = (
    descriptor: FrameworkVersionDescriptor,
    spec: string
): string => {
    if (descriptor.source.kind !== 'npm')
        throw new Error(
            `buildNpmUpgradeShell: ${descriptor.framework} is not an npm framework`
        )
    const bin = descriptor.binName
    const pkg = descriptor.source.package
    const allowScripts = descriptor.npmAllowInstallScripts
        ? ` --allow-scripts=${pkg}`
        : ''
    // A dist-tag or range resolves registry-side so the exact version is
    // unknowable here; any parseable version proves the candidate executes. An
    // exact spec must match, or a wrong resolution would be committed silently.
    //
    // The exact check reads the STAGED PACKAGE'S OWN MANIFEST rather than
    // `--version` output. `--version` is per-CLI freeform text: the previous
    // `grep -oE '[0-9]+\.[0-9]+\.[0-9]+'` could not see a `-rc.1` suffix, so an
    // exact prerelease spec could never be accepted, and a CLI that prints only
    // its core version would silently satisfy a prerelease target. The manifest
    // is the artefact npm actually installed. `--version` still has to run and
    // print something — that is what catches npm 12 blocking an install script
    // and leaving a placeholder bin behind (#438) — it just no longer has to
    // carry the version assertion too.
    const exact = isSemverVersionTag(spec)
    const acceptCandidate = exact
        ? [
              // `npm root -g --prefix` is the documented way to resolve the
              // install root; the literal layout is kept as a fallback so a
              // future npm changing that output cannot break every install.
              `root_dir="$(npm root -g --prefix "$staging" 2>/dev/null || true)"`,
              `[ -d "$root_dir" ] || root_dir="$staging/lib/node_modules"`,
              `manifest="$root_dir/${pkg}/package.json"`,
              `installed="$(node -p "require('$manifest').version" 2>/dev/null || true)"`,
              `[ "$installed" = "${stripV(spec)}" ] || { echo "staged ${pkg} reports \${installed:-no version}, expected ${stripV(spec)}" >&2; exit 1; }`
          ]
        : [
              `got="$(printf '%s\\n' "$out" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`,
              `[ -n "$got" ] || { echo "candidate ${bin} reports no version: $out" >&2; exit 1; }`
          ]
    return [
        'set -eu',
        'mkdir -p "$HOME/.local/bin"',
        'export PATH="$HOME/.local/bin:$PATH"',
        `root="$HOME/.local/lib/manyfold/${bin}"`,
        'mkdir -p "$root"',
        'staging="$(mktemp -d "$root/install.XXXXXX")"',
        `trap 'rm -rf "$staging" "$staging.link"' EXIT`,
        // quoted: a denylist-derived spec is a semver range carrying spaces,
        // `<`, `>` and `||`, all of which the shell would otherwise eat
        `npm install -g --prefix "$staging"${allowScripts} '${pkg}@${exact ? stripV(spec) : spec}'`,
        `candidate="$staging/bin/${bin}"`,
        `out="$("$candidate" --version 2>&1)" || { echo "candidate ${bin} failed to run: $out" >&2; exit 1; }`,
        ...acceptCandidate,
        `ln -s "$candidate" "$staging.link"`,
        `mv -Tf "$staging.link" "$HOME/.local/bin/${bin}"`,
        'trap - EXIT',
        ...(descriptor.unshadowNodeBinDir
            ? [buildUnshadowActivationShell(bin)]
            : []),
        'hash -r',
        `for d in "$root"/install.*; do [ "$d" = "$staging" ] || rm -rf "$d"; done`,
        // Activation is not finished when the symlink lands: a sprite whose
        // shells resolve the image's global bin first still runs the old binary
        // from the terminal, from the sprite-side runner, and from a framework
        // tool's own child shell (#611). Reconciling here — rather than only at
        // provision — is what carries the fix to sprites that already exist:
        // this shell IS the upgrade every affected sprite has to run anyway.
        buildManagedShellReconcileScript()
    ].join('\n')
}

// npm has no `v` prefix on published versions, while a github-sourced tag and an
// admin pin both may carry one. Ranges pass through untouched.
const stripV = (spec: string): string => spec.replace(/^[vV]/, '')
