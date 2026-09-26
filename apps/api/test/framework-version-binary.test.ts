import {
    registerFramework,
    upgradesInPlace,
    type FrameworkDefaultVersionsSettings,
    type FrameworkDefinition
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BootstrapError } from '../src/modules/agents/bootstrap/framework-bootstrap'
import {
    installFrameworkVersionOn,
    type HostScriptRunner
} from '../src/modules/agents/bootstrap/framework-version-install'
import {
    buildBinaryInstallShell,
    buildVersionInstallShell,
    frameworkVersionDescriptor,
    githubSource,
    registerFrameworkVersionDescriptor,
    releaseArtifactsFrom,
    type FrameworkReleaseArtifacts
} from '../src/modules/framework-versions/framework-version-registry'
import { FrameworkVersionsService } from '../src/modules/framework-versions/framework-versions.service'
import { resolveFrameworkInstallVersion } from '../src/modules/framework-versions/resolve-install-version'

// A coding CLI shipped as a prebuilt binary on its GitHub releases.
const BIN_FIXTURE = 'fixture-binary-cli'
const BIN_REPO = 'example-org/fixture-binary-cli'
const X64_ASSET = 'fixture_cli_linux_x64.tar.gz'
const ARM_ASSET = 'fixture_cli_linux_arm64.tar.gz'

const definition: FrameworkDefinition = {
    id: BIN_FIXTURE,
    displayName: 'Fixture Binary CLI',
    kind: 'coding',
    runtimes: ['sprites', 'k8s'],
    chat: {
        streaming: true,
        toolCalls: true,
        thinking: false,
        attachments: false,
        multiTurn: true
    },
    version: {
        upgradeMode: 'binary',
        repoCandidates: [{ repo: BIN_REPO, label: 'example-org' }]
    },
    defaultRuntime: 'sprites'
}
registerFramework(definition)
registerFrameworkVersionDescriptor({
    framework: BIN_FIXTURE,
    runtimeKind: 'coding',
    source: githubSource(BIN_FIXTURE),
    binName: 'fixcli',
    binary: {
        assets: { x86_64: X64_ASSET, aarch64: ARM_ASSET },
        member: 'fixture-cli',
        env: { FIXCLI_NO_UPDATE: 'true' }
    },
    probeShell: 'export PATH="$HOME/.local/bin:$PATH"; fixcli --version'
})

const descriptor = frameworkVersionDescriptor(BIN_FIXTURE)
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const artifacts: FrameworkReleaseArtifacts = { x86_64: A, aarch64: B }
const shell = buildBinaryInstallShell(descriptor, '1.2.11', artifacts)

test('binary installs are in-place upgrades, rebuilds are not', () => {
    assert.equal(upgradesInPlace('binary'), true)
    assert.equal(upgradesInPlace('npm'), true)
    assert.equal(upgradesInPlace('rebuild'), false)
    assert.equal(upgradesInPlace(null), false)
})

test('the download URL comes from the repository and version only', () => {
    assert.ok(
        shell.includes(
            `"https://github.com/${BIN_REPO}/releases/download/1.2.11/$asset"`
        )
    )
    assert.match(shell, /curl -fsSL --proto '=https'/)
    assert.match(
        shell,
        new RegExp(`x86_64\\|amd64\\) asset='${X64_ASSET}'; sha='${A}'`)
    )
    assert.match(
        shell,
        new RegExp(`aarch64\\|arm64\\) asset='${ARM_ASSET}'; sha='${B}'`)
    )
})

test('the digest is checked before anything is extracted or run', () => {
    const verify = shell.indexOf('sha256sum -c')
    assert.ok(verify > 0)
    assert.ok(verify < shell.indexOf('tar -xzf'))
    assert.ok(verify < shell.indexOf('--version'))
})

test('the candidate must report the exact version before the swap', () => {
    assert.match(shell, /FIXCLI_NO_UPDATE=true "\$candidate" --version/)
    assert.match(shell, /\[ "\$got" = "1\.2\.11" \]/)
    assert.ok(shell.indexOf('[ "$got" =') < shell.indexOf('mv -Tf'))
    assert.match(
        shell,
        /mv -Tf "\$staging\.link" "\$HOME\/\.local\/bin\/fixcli"/
    )
})

test('staging is cleaned on failure and the trap cleared after commit', () => {
    assert.ok(shell.indexOf("trap 'rm -rf") < shell.indexOf('curl'))
    assert.ok(shell.indexOf('trap - EXIT') > shell.indexOf('mv -Tf'))
})

test('a v-prefixed tag keeps its URL segment but checks the bare version', () => {
    const tagged = buildBinaryInstallShell(descriptor, 'v2.0.0', artifacts)
    assert.ok(tagged.includes('/releases/download/v2.0.0/$asset'))
    assert.match(tagged, /\[ "\$got" = "2\.0\.0" \]/)
})

test('a binary shell is refused without real semver or complete digests', () => {
    assert.throws(() =>
        buildBinaryInstallShell(descriptor, 'latest', artifacts)
    )
    assert.throws(() =>
        buildBinaryInstallShell(descriptor, '1.2.11', {
            x86_64: A,
            aarch64: ''
        })
    )
    assert.throws(() =>
        buildBinaryInstallShell(descriptor, '1.2.11', {
            x86_64: A,
            aarch64: 'sha256:' + B
        })
    )
    assert.throws(() => buildVersionInstallShell(descriptor, '1.2.11', null))
    assert.throws(() =>
        buildBinaryInstallShell(
            frameworkVersionDescriptor('claude-code'),
            '1.2.11',
            artifacts
        )
    )
})

test('the binary install shell is valid POSIX sh and bash', () => {
    for (const interpreter of ['bash', 'sh'])
        execFileSync(interpreter, ['-n'], { input: shell })
})

test('a release offers digests only when every Linux asset carries one', () => {
    const asset = (name: string, digest: string | null) => ({
        name,
        ...(digest ? { digest } : {})
    })
    assert.deepEqual(
        releaseArtifactsFrom(
            [asset(X64_ASSET, `sha256:${A}`), asset(ARM_ASSET, `sha256:${B}`)],
            descriptor.binary!
        ),
        artifacts
    )
    assert.equal(
        releaseArtifactsFrom(
            [asset(X64_ASSET, `sha256:${A}`)],
            descriptor.binary!
        ),
        null
    )
    assert.equal(
        releaseArtifactsFrom(
            [asset(X64_ASSET, `sha256:${A}`), asset(ARM_ASSET, null)],
            descriptor.binary!
        ),
        null
    )
    assert.equal(
        releaseArtifactsFrom(
            [asset(X64_ASSET, `sha512:${A}`), asset(ARM_ASSET, `sha256:${B}`)],
            descriptor.binary!
        ),
        null
    )
    assert.equal(releaseArtifactsFrom('nope', descriptor.binary!), null)
})

// The install itself, on a real shell: a fake `curl` serves the tarball, and
// GNU coreutils do the rest, which is what sprites and pod hosts run.
const linuxOnly =
    process.platform === 'linux'
        ? false
        : 'needs GNU coreutils (mv -T, sha256sum) as on a Linux host'

const installLab = (candidateVersion: string, homeName = 'home') => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'binary-install-')))
    const home = join(root, homeName)
    const fake = join(root, 'fakebin')
    const pack = join(root, 'pack')
    mkdirSync(home, { recursive: true })
    mkdirSync(fake, { recursive: true })
    mkdirSync(pack, { recursive: true })
    writeFileSync(
        join(pack, 'fixture-cli'),
        `#!/bin/sh\n[ "$FIXCLI_NO_UPDATE" = true ] || { echo "updater on" >&2; exit 9; }\n[ "$1" = --version ] || { printf '%s|' "$@"; exit 7; }\necho "fixture-cli ${candidateVersion}"\n`
    )
    chmodSync(join(pack, 'fixture-cli'), 0o755)
    const tarball = join(root, 'asset.tar.gz')
    execFileSync('tar', ['-czf', tarball, '-C', pack, 'fixture-cli'])
    writeFileSync(
        join(fake, 'curl'),
        [
            '#!/bin/sh',
            'out=""',
            'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) last="$1"; shift ;; esac; done',
            `echo "$last" >> "${root}/curl.log"`,
            `cp "${tarball}" "$out"`
        ].join('\n')
    )
    chmodSync(join(fake, 'curl'), 0o755)
    const digest = createHash('sha256')
        .update(readFileSync(tarball))
        .digest('hex')
    const run = (script: string) =>
        spawnSync('bash', ['-c', script], {
            env: { HOME: home, PATH: `${fake}:/usr/bin:/bin` },
            encoding: 'utf8'
        })
    return { root, home, digest, run }
}

test(
    'an install lands the validated binary behind the PATH symlink, its env set by a launcher',
    { skip: linuxOnly },
    () => {
        const lab = installLab('1.2.11')
        try {
            const result = lab.run(
                buildBinaryInstallShell(descriptor, '1.2.11', {
                    x86_64: lab.digest,
                    aarch64: lab.digest
                })
            )
            assert.equal(result.status, 0, result.stderr)
            const link = join(lab.home, '.local/bin/fixcli')
            assert.match(
                readlinkSync(link),
                /\/\.local\/lib\/manyfold\/fixcli\/install\.[^/]+\/launch$/
            )
            // The fixture exits 9 unless its updater is off: whoever runs it
            // by name gets the env without asking for it.
            assert.match(execFileSync(link, { env: {} }).toString(), /1\.2\.11/)
            assert.match(
                readFileSync(join(lab.root, 'curl.log'), 'utf8'),
                new RegExp(
                    `https://github.com/${BIN_REPO}/releases/download/1\\.2\\.11/fixture_cli_linux_`
                )
            )
        } finally {
            rmSync(lab.root, { recursive: true, force: true })
        }
    }
)

test(
    'the launcher passes arguments and the exit code through, whatever the home path holds',
    { skip: linuxOnly },
    () => {
        const lab = installLab('1.2.11', "it's a home")
        try {
            const result = lab.run(
                buildBinaryInstallShell(descriptor, '1.2.11', {
                    x86_64: lab.digest,
                    aarch64: lab.digest
                })
            )
            assert.equal(result.status, 0, result.stderr)
            const run = spawnSync(
                join(lab.home, '.local/bin/fixcli'),
                ['a b', "c'd"],
                { env: {}, encoding: 'utf8' }
            )
            assert.equal(run.status, 7)
            assert.equal(run.stdout, "a b|c'd|")
        } finally {
            rmSync(lab.root, { recursive: true, force: true })
        }
    }
)

test(
    'a download that fails its digest never reaches PATH',
    { skip: linuxOnly },
    () => {
        const lab = installLab('1.2.11')
        try {
            const result = lab.run(
                buildBinaryInstallShell(descriptor, '1.2.11', artifacts)
            )
            assert.equal(result.status, 1)
            assert.match(result.stderr, /does not match its published sha256/)
            assert.equal(
                spawnSync('test', ['-e', join(lab.home, '.local/bin/fixcli')])
                    .status,
                1
            )
        } finally {
            rmSync(lab.root, { recursive: true, force: true })
        }
    }
)

test(
    'a binary reporting another version leaves the previous CLI in place',
    { skip: linuxOnly },
    () => {
        const lab = installLab('9.9.9')
        try {
            mkdirSync(join(lab.home, '.local/bin'), { recursive: true })
            writeFileSync(
                join(lab.home, '.local/bin/fixcli'),
                '#!/bin/sh\necho previous\n'
            )
            const result = lab.run(
                buildBinaryInstallShell(descriptor, '1.2.11', {
                    x86_64: lab.digest,
                    aarch64: lab.digest
                })
            )
            assert.equal(result.status, 1)
            assert.match(result.stderr, /reports 9\.9\.9, expected 1\.2\.11/)
            assert.equal(
                readFileSync(join(lab.home, '.local/bin/fixcli'), 'utf8'),
                '#!/bin/sh\necho previous\n'
            )
        } finally {
            rmSync(lab.root, { recursive: true, force: true })
        }
    }
)

// ---- catalog --------------------------------------------------------------

const release = (
    tag: string,
    opts: { draft?: boolean; prerelease?: boolean; digests?: boolean } = {}
) => ({
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    assets:
        opts.digests === false
            ? [{ name: X64_ASSET }, { name: ARM_ASSET }]
            : [
                  { name: X64_ASSET, digest: `sha256:${A}` },
                  { name: ARM_ASSET, digest: `sha256:${B}` }
              ]
})

const serviceWith = (stored: unknown) => {
    const db = {
        written: null as { frameworks: Record<string, unknown> } | null,
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ valueJson: { frameworks: stored } }]
                })
            })
        }),
        insert: () => ({
            values: (row: {
                valueJson: { frameworks: Record<string, unknown> }
            }) => ({
                onConflictDoUpdate: async () => {
                    db.written = row.valueJson
                }
            })
        })
    }
    const settings: FrameworkDefaultVersionsSettings = {
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {},
        sourceRepos: {},
        allowPrerelease: {}
    }
    return {
        db,
        service: new FrameworkVersionsService(
            db as never,
            { get: () => undefined } as never,
            { getCachedFrameworkDefaultVersions: async () => settings } as never
        )
    }
}

const withFetch = async <T>(
    handler: (url: string) => unknown,
    body: () => Promise<T>
): Promise<{ result: T; urls: string[] }> => {
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL) => {
        const url = String(input)
        urls.push(url)
        const payload = handler(url)
        return new Response(JSON.stringify(payload), {
            status: payload === undefined ? 404 : 200,
            headers: { 'content-type': 'application/json' }
        })
    }) as typeof fetch
    try {
        return { result: await body(), urls }
    } finally {
        globalThis.fetch = original
    }
}

test('the catalog of a binary framework is its complete, published releases', async () => {
    const { service, db } = serviceWith({})
    const { urls } = await withFetch(
        () => [
            release('1.3.0', { draft: true }),
            release('1.2.12', { prerelease: true }),
            release('1.2.11'),
            release('1.2.10', { digests: false }),
            release('1.2.9'),
            release('1.3.0-rc.1', { prerelease: true })
        ],
        () => service.refreshFramework(BIN_FIXTURE)
    )
    assert.deepEqual(urls, [
        `https://api.github.com/repos/${BIN_REPO}/releases?per_page=100`
    ])
    const entry = db.written!.frameworks[BIN_FIXTURE] as {
        latest: string
        versions: string[]
        prereleases: string[]
        artifacts: Record<string, FrameworkReleaseArtifacts>
    }
    assert.equal(entry.latest, '1.2.11')
    assert.deepEqual(entry.versions, ['1.2.11', '1.2.9'])
    assert.deepEqual(entry.prereleases, ['1.3.0-rc.1'])
    assert.deepEqual(Object.keys(entry.artifacts).sort(), [
        '1.2.11',
        '1.2.9',
        '1.3.0-rc.1'
    ])
    assert.deepEqual(entry.artifacts['1.2.11'], artifacts)
})

test('release digests come from the stored catalog, else from that one release', async () => {
    const stored = {
        [BIN_FIXTURE]: {
            latest: '1.2.11',
            versions: ['1.2.11'],
            prereleases: [],
            source: 'github',
            repo: BIN_REPO,
            fetchedAt: new Date().toISOString(),
            artifacts: { '1.2.11': artifacts }
        }
    }
    const { service } = serviceWith(stored)
    const cached = await withFetch(
        () => undefined,
        () => service.releaseArtifacts(BIN_FIXTURE, '1.2.11')
    )
    assert.deepEqual(cached.result, artifacts)
    assert.deepEqual(cached.urls, [])

    const fetched = await withFetch(
        (url) =>
            url.endsWith('/releases/tags/1.2.8') ? release('1.2.8') : undefined,
        () => service.releaseArtifacts(BIN_FIXTURE, '1.2.8')
    )
    assert.deepEqual(fetched.result, artifacts)
    assert.deepEqual(fetched.urls, [
        `https://api.github.com/repos/${BIN_REPO}/releases/tags/1.2.8`
    ])

    await assert.rejects(
        withFetch(
            () => release('1.2.7', { digests: false }),
            () => service.releaseArtifacts(BIN_FIXTURE, '1.2.7')
        ),
        /no complete set of Linux release assets/
    )
})

// ---- resolve + install ----------------------------------------------------

const resolveDeps = (
    releaseArtifacts: (
        framework: string,
        version: string
    ) => Promise<FrameworkReleaseArtifacts>
) => ({
    settings: {
        defaults: {},
        minVersions: {},
        allowDowngrade: {},
        blockedVersions: {},
        sourceRepos: {},
        allowPrerelease: {}
    },
    latestForFresh: async () => '1.2.11',
    catalogForFresh: async () => ({
        framework: BIN_FIXTURE,
        latest: '1.2.11',
        versions: ['1.2.11'],
        source: 'github' as const,
        sourceRepo: BIN_REPO,
        fetchedAt: new Date().toISOString(),
        blocked: []
    }),
    releaseArtifacts
})

test('a fresh install of a binary framework resolves the release digests with the version', async () => {
    const asked: string[] = []
    const resolved = await resolveFrameworkInstallVersion(
        resolveDeps(async (_framework, version) => {
            asked.push(version)
            return artifacts
        }),
        BIN_FIXTURE
    )
    assert.equal(resolved.selection.version, '1.2.11')
    assert.equal(resolved.repo, BIN_REPO)
    assert.deepEqual(resolved.artifacts, artifacts)
    assert.deepEqual(asked, ['1.2.11'])
})

test('a binary install whose digests cannot be read is refused, not left unchecked', async () => {
    await assert.rejects(
        resolveFrameworkInstallVersion(
            resolveDeps(async () => {
                throw new Error('rate limited')
            }),
            BIN_FIXTURE
        ),
        /release digests are unavailable: rate limited/
    )
})

const scriptedRunner = (installed: string | null) => {
    const scripts: string[] = []
    const runner: HostScriptRunner = {
        run: async (script) => {
            scripts.push(script)
            return script.includes('--version') &&
                script.startsWith('export PATH')
                ? { exitCode: 0, stdout: installed ?? '', stderr: '' }
                : { exitCode: 0, stdout: '', stderr: '' }
        },
        warn: () => undefined
    }
    return { runner, scripts }
}

test('a binary framework with no resolved release and no binary cannot install', async () => {
    const { runner } = scriptedRunner(null)
    await assert.rejects(
        installFrameworkVersionOn(runner, {}, BIN_FIXTURE),
        (err: unknown) =>
            err instanceof BootstrapError &&
            /no fixture-binary-cli release resolved/.test(err.message)
    )
})

test('an asked-for binary release without digests fails instead of installing unchecked', async () => {
    const { runner, scripts } = scriptedRunner('1.2.9')
    await assert.rejects(
        installFrameworkVersionOn(
            runner,
            { frameworkVersion: '1.2.11', frameworkVersionSource: 'explicit' },
            BIN_FIXTURE
        ),
        /no release digests resolved/
    )
    assert.ok(!scripts.some((s) => s.includes('releases/download')))
})

test('an install with digests runs the release-binary shell', async () => {
    const { runner, scripts } = scriptedRunner('1.2.9')
    await installFrameworkVersionOn(
        runner,
        {
            frameworkVersion: '1.2.11',
            frameworkVersionSource: 'latest',
            frameworkArtifacts: artifacts
        },
        BIN_FIXTURE
    )
    assert.ok(
        scripts.some((s) =>
            s.includes(`github.com/${BIN_REPO}/releases/download/1.2.11/`)
        )
    )
})
