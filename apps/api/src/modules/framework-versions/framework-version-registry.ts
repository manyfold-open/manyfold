import {
    AGY_MANAGED_HOST_ENV,
    BUILTIN_BLOCKED_FRAMEWORK_VERSIONS,
    buildManagedPathScript,
    type CoreVersionedFramework,
    VersionedFramework,
    defaultFrameworkRepo,
    isSemverVersionTag,
    safeNpmVersionSpec,
    UnknownFrameworkError
} from '@manyfold/shared'

// Single source of truth for per-framework version metadata. Today the
// install/pin logic lives scattered across the bootstrap files
// (claude-code.ts, codex.ts, gemini.ts, openclaw-sprite.ts, hermes-sprite.ts,
// and each framework module's own); this registry centralises the descriptive
// bits the catalog + probe + upgrade paths all need.

export type FrameworkVersionSource =
    | { kind: 'npm'; package: string }
    // repo is `owner/name`; GitHub releases drive the catalog (wired in P3).
    // This is only the DEFAULT — an admin can point a framework at another of
    // its candidates, so read the effective repo from
    // FrameworkVersionsService.repoFor() rather than from here.
    | { kind: 'github'; repo: string }

// `uname -m` of the Linux hosts the platform installs on (sprites, pod hosts).
const RELEASE_ARCHES = ['x86_64', 'aarch64'] as const
type ReleaseArch = (typeof RELEASE_ARCHES)[number]

// A framework shipped as a prebuilt binary on its GitHub releases ('binary'
// upgrade mode): the Linux tarball per architecture, and the one file inside
// it that becomes `binName`.
export interface FrameworkReleaseBinary {
    assets: Record<ReleaseArch, string>
    member: string
    // Env every platform-driven run of the binary carries (its self-updater
    // off, so the version on a host stays the one the platform installed).
    env?: Readonly<Record<string, string>>
}

// The sha256 GitHub publishes for each Linux asset of one release. Resolved on
// the control plane and written into the install shell, so a host never has
// to reach the GitHub API itself.
export type FrameworkReleaseArtifacts = Record<ReleaseArch, string>

// A release is installable only when every Linux asset is present with the
// digest GitHub computed on upload; one that lacks any is not offered at all.
export const releaseArtifactsFrom = (
    assets: unknown,
    binary: FrameworkReleaseBinary
): FrameworkReleaseArtifacts | null => {
    if (!Array.isArray(assets)) return null
    const digestOf = (name: string): string | null => {
        const asset = assets.find(
            (a) =>
                a &&
                typeof a === 'object' &&
                (a as { name?: unknown }).name === name
        ) as { digest?: unknown } | undefined
        const match =
            typeof asset?.digest === 'string'
                ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)
                : null
        return match ? match[1] : null
    }
    const x86_64 = digestOf(binary.assets.x86_64)
    const aarch64 = digestOf(binary.assets.aarch64)
    return x86_64 && aarch64 ? { x86_64, aarch64 } : null
}

// The descriptor's default and the admin picker's first option have to be the
// same repository, or an unconfigured platform would fetch one repo while the
// UI claimed another. Taking both from the shared candidate list makes that
// impossible to get wrong; framework-version-registry.test.ts pins it.
export const githubSource = (
    framework: VersionedFramework
): FrameworkVersionSource => {
    const repo = defaultFrameworkRepo(framework)
    if (!repo)
        throw new Error(`no repo candidates declared for ${framework}`)
    return { kind: 'github', repo }
}

export interface FrameworkVersionDescriptor {
    framework: VersionedFramework
    // 'coding' = a CLI set up by setUpHostFramework (no long-running service
    // to restart);
    // 'daemon' = a service framework the host's daemon runs (its service
    // must restart after an upgrade).
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
    // Set for a 'binary' framework (github source only): installs come from
    // its release assets instead of npm or a clone.
    binary?: FrameworkReleaseBinary
    // shell run under `bash -lc` that prints the installed version to stdout.
    // ~/.local/bin is prepended because npm-global bins are not on the default
    // non-interactive PATH (see openclaw-sprite.ts symlink note).
    probeShell: string
    // sprite Services API name to restart after a daemon upgrade
    serviceName?: string
}

const CORE_DESCRIPTORS = {
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
    pi: {
        framework: 'pi',
        runtimeKind: 'coding',
        source: { kind: 'npm', package: '@earendil-works/pi-coding-agent' },
        binName: 'pi',
        unshadowNodeBinDir: true,
        // PI_OFFLINE keeps the probe from reaching pi.dev for an update check.
        probeShell:
            'export PATH="$HOME/.local/bin:$PATH"; PI_OFFLINE=1 pi --version'
    },
    // agy prints its bare version (`1.2.11`) on stdout. Release assets
    // measured on 1.2.11 [2026-09-26]: one tarball per platform holding a
    // single `antigravity` binary, each asset carrying a GitHub sha256.
    'antigravity-cli': {
        framework: 'antigravity-cli',
        runtimeKind: 'coding',
        source: githubSource('antigravity-cli'),
        binName: 'agy',
        binary: {
            assets: {
                x86_64: 'agy_cli_linux_x64.tar.gz',
                aarch64: 'agy_cli_linux_arm64.tar.gz'
            },
            member: 'antigravity',
            env: AGY_MANAGED_HOST_ENV
        },
        probeShell:
            'export PATH="$HOME/.local/bin:$PATH"; AGY_CLI_DISABLE_AUTO_UPDATE=true agy --version'
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
        // and reads as "not detected" until upgraded to a tag.
        probeShell:
            'git -C "$HOME/.hermes/hermes-agent" describe --tags 2>/dev/null || true',
        serviceName: 'hermes'
    }
} satisfies Record<CoreVersionedFramework, FrameworkVersionDescriptor>

// Descriptors of frameworks whose module registers them through
// FrameworkExtensionsRegistry (ADR-0034).
const extensionDescriptors = new Map<string, FrameworkVersionDescriptor>()

export const registerFrameworkVersionDescriptor = (
    descriptor: FrameworkVersionDescriptor
): void => {
    if (
        descriptor.framework in CORE_DESCRIPTORS ||
        extensionDescriptors.has(descriptor.framework)
    )
        throw new Error(
            `framework '${descriptor.framework}' already has a version descriptor`
        )
    extensionDescriptors.set(descriptor.framework, descriptor)
}

// Throws UnknownFrameworkError for a framework with no version descriptor.
export const frameworkVersionDescriptor = (
    framework: VersionedFramework
): FrameworkVersionDescriptor => {
    const descriptor =
        CORE_DESCRIPTORS[framework as CoreVersionedFramework] ??
        extensionDescriptors.get(framework)
    if (!descriptor) throw new UnknownFrameworkError(framework)
    return descriptor
}

export const allFrameworkVersionDescriptors =
    (): FrameworkVersionDescriptor[] => [
        ...Object.values(CORE_DESCRIPTORS),
        ...extensionDescriptors.values()
    ]

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

const envAssignments = (
    env: Readonly<Record<string, string>> | undefined
): string[] =>
    Object.entries(env ?? {}).map(([name, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[A-Za-z0-9._-]*$/.test(value))
            throw new Error(`unsafe binary env ${name}`)
        return `${name}=${value}`
    })

const envPrefix = (env: Readonly<Record<string, string>> | undefined): string =>
    envAssignments(env)
        .map((assignment) => `${assignment} `)
        .join('')

// One install of a framework at a time on a machine: a second one waits for
// the first to finish instead of staging beside it. flock ships with
// util-linux on every hosted image; where it is missing, the cleanup below
// still leaves alone any install another one may own.
// Seen on staging [2026-10-07]: a retried openclaw install ran beside the
// first, each deleted the other's staging dir, and the survivor went on PATH
// with 6,897 of its 13,320 files.
const installLockLines = (): string[] => [
    'if command -v flock >/dev/null 2>&1; then',
    '  exec 9>"$root/.install.lock"',
    '  flock 9',
    'fi'
]

// No install runs this long: each one's exec has a budget of minutes.
const STALE_INSTALL_MINUTES = 60

// Removes the installs this one superseded. A dir is kept while PATH still
// resolves into it (another install may have committed after this one) or
// while it is young enough to be another install still extracting.
const staleInstallCleanupLines = (bin: string): string[] => [
    `linked="$(readlink "$HOME/.local/bin/${bin}" 2>/dev/null || true)"`,
    'for d in "$root"/install.*; do',
    '  [ "$d" = "$staging" ] && continue',
    '  case "$linked" in "$d"/*) continue ;; esac',
    `  [ -n "$(find "$d" -maxdepth 0 -mmin +${STALE_INSTALL_MINUTES} 2>/dev/null)" ] || continue`,
    '  rm -rf "$d"',
    'done'
]

// What PATH resolves to. A binary's env belongs to running it at all, not
// only to the version check: agy starts its self-updater from any command,
// and a managed host keeps the version the platform installed, a terminal
// user's `agy` included. So a binary with env gets a launcher beside it that
// exports that env and execs it, with the binary's path quoted in.
const launcherLines = (
    env: Readonly<Record<string, string>> | undefined
): string[] => {
    const assignments = envAssignments(env)
    if (assignments.length === 0) return ['entry="$candidate"']
    return [
        'entry="$staging/launch"',
        `printf '#!/bin/sh\\n' > "$entry"`,
        ...assignments.map(
            (assignment) => `printf 'export %s\\n' '${assignment}' >> "$entry"`
        ),
        `printf 'exec %s "$@"\\n' "'$(printf '%s' "$candidate" | sed "s/'/'\\\\\\\\''/g")'" >> "$entry"`,
        'chmod 0755 "$entry"'
    ]
}

// Shell (for `bash -lc`) that installs a 'binary' framework at an exact
// release: the Linux tarball for this host's architecture, checked against the
// sha256 its GitHub release publishes, then the same validate-then-swap commit
// the npm shell uses — the staged binary must run and report the target
// version before `~/.local/bin/<bin>` changes, and the swap is one atomic
// rename, so every failure leaves the previous CLI runnable. The URL is built
// here from the repository and version, never taken from anywhere else.
export const buildBinaryInstallShell = (
    descriptor: FrameworkVersionDescriptor,
    version: string,
    artifacts: FrameworkReleaseArtifacts
): string => {
    const { binary, source } = descriptor
    if (!binary || source.kind !== 'github')
        throw new Error(
            `buildBinaryInstallShell: ${descriptor.framework} is not a release-binary framework`
        )
    if (!isSemverVersionTag(version))
        throw new Error(`buildBinaryInstallShell: invalid version "${version}"`)
    for (const arch of RELEASE_ARCHES)
        if (!/^[0-9a-f]{64}$/.test(artifacts[arch] ?? ''))
            throw new Error(
                `buildBinaryInstallShell: no sha256 for the ${arch} asset of ${descriptor.framework} ${version}`
            )
    const bin = descriptor.binName
    const tag = version.trim()
    const expected = stripV(tag)
    const base = `https://github.com/${source.repo}/releases/download/${tag}`
    return [
        'set -eu',
        'case "$(uname -s)" in',
        '  Linux) ;;',
        `  *) echo "${bin}: release binaries install on Linux hosts only" >&2; exit 1 ;;`,
        'esac',
        'case "$(uname -m)" in',
        `  x86_64|amd64) asset='${binary.assets.x86_64}'; sha='${artifacts.x86_64}' ;;`,
        `  aarch64|arm64) asset='${binary.assets.aarch64}'; sha='${artifacts.aarch64}' ;;`,
        `  *) echo "${bin}: no release asset for $(uname -m)" >&2; exit 1 ;;`,
        'esac',
        'mkdir -p "$HOME/.local/bin"',
        'export PATH="$HOME/.local/bin:$PATH"',
        `root="$HOME/.local/lib/manyfold/${bin}"`,
        'mkdir -p "$root"',
        ...installLockLines(),
        'staging="$(mktemp -d "$root/install.XXXXXX")"',
        `trap 'rm -rf "$staging" "$staging.link"' EXIT`,
        `curl -fsSL --proto '=https' --retry 3 -o "$staging/$asset" "${base}/$asset"`,
        `printf '%s  %s\\n' "$sha" "$staging/$asset" | sha256sum -c - >/dev/null || { echo "${bin} ${expected}: $asset does not match its published sha256" >&2; exit 1; }`,
        `tar -xzf "$staging/$asset" -C "$staging" '${binary.member}'`,
        'rm -f "$staging/$asset"',
        `mv "$staging/${binary.member}" "$staging/${bin}"`,
        `chmod 0755 "$staging/${bin}"`,
        `candidate="$staging/${bin}"`,
        `out="$(${envPrefix(binary.env)}"$candidate" --version 2>&1)" || { echo "candidate ${bin} failed to run: $out" >&2; exit 1; }`,
        `got="$(printf '%s\\n' "$out" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`,
        `[ "$got" = "${expected}" ] || { echo "staged ${bin} reports \${got:-no version}, expected ${expected}" >&2; exit 1; }`,
        ...launcherLines(binary.env),
        `ln -s "$entry" "$staging.link"`,
        `mv -Tf "$staging.link" "$HOME/.local/bin/${bin}"`,
        'trap - EXIT',
        'hash -r',
        ...staleInstallCleanupLines(bin),
        buildManagedPathScript()
    ].join('\n')
}

// The exact-version install shell for any framework that installs in place.
// A 'binary' framework needs its release's digests; an npm one ignores them.
export const buildVersionInstallShell = (
    descriptor: FrameworkVersionDescriptor,
    version: string,
    artifacts: FrameworkReleaseArtifacts | null
): string => {
    if (!descriptor.binary) return buildNpmUpgradeShell(descriptor, version)
    if (!artifacts)
        throw new Error(
            `no release digests resolved for ${descriptor.framework} ${version}`
        )
    return buildBinaryInstallShell(descriptor, version, artifacts)
}

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
    // Either way the staged package must carry its own manifest: a bin that
    // still answers `--version` from a half-extracted package (openclaw's has
    // a fast path that loads nothing else) proves the install, not the files.
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
    const readManifest = [
        // `npm root -g --prefix` is the documented way to resolve the install
        // root; the literal layout is kept as a fallback so a future npm
        // changing that output cannot break every install.
        `root_dir="$(npm root -g --prefix "$staging" 2>/dev/null || true)"`,
        `[ -d "$root_dir" ] || root_dir="$staging/lib/node_modules"`,
        `manifest="$root_dir/${pkg}/package.json"`,
        `installed="$(node -p "require('$manifest').version" 2>/dev/null || true)"`
    ]
    const acceptCandidate = exact
        ? [
              ...readManifest,
              `[ "$installed" = "${stripV(spec)}" ] || { echo "staged ${pkg} reports \${installed:-no version}, expected ${stripV(spec)}" >&2; exit 1; }`
          ]
        : [
              `got="$(printf '%s\\n' "$out" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)"`,
              `[ -n "$got" ] || { echo "candidate ${bin} reports no version: $out" >&2; exit 1; }`,
              ...readManifest,
              `printf '%s\\n' "$installed" | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+' || { echo "staged ${pkg} has no readable manifest (\${installed:-none}); the install is incomplete" >&2; exit 1; }`
          ]
    return [
        'set -eu',
        'mkdir -p "$HOME/.local/bin"',
        'export PATH="$HOME/.local/bin:$PATH"',
        `root="$HOME/.local/lib/manyfold/${bin}"`,
        'mkdir -p "$root"',
        ...installLockLines(),
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
        ...staleInstallCleanupLines(bin),
        // Activation is not finished when the symlink lands: a sprite whose
        // shells resolve the image's global bin first still runs the old binary
        // from the terminal, from the sprite-side runner, and from a framework
        // tool's own child shell (#611). Reconciling here — rather than only at
        // provision — is what carries the fix to sprites that already exist:
        // this shell IS the upgrade every affected sprite has to run anyway.
        buildManagedPathScript()
    ].join('\n')
}

// npm has no `v` prefix on published versions, while a github-sourced tag and an
// admin pin both may carry one. Ranges pass through untouched.
const stripV = (spec: string): string => spec.replace(/^[vV]/, '')
