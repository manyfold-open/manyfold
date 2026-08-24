import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The installer resolves a release manifest, then downloads the one artifact
// the manifest names — two calls, not three: the checksum travels inside the
// manifest instead of a detached sibling. The fake curl below serves the
// manifest when invoked without -o and writes empty files otherwise, so these
// tests pin the call shape without touching the network.

interface InstallerHarness {
    env: NodeJS.ProcessEnv
    installDir: string
    installScript: string
    root: string
}

const installerUrl = new URL('../install.sh', import.meta.url)

const platformTarget = (): string => {
    const os = process.platform === 'darwin' ? 'darwin' : 'linux'
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return `${os}-${arch}`
}

// Byte-for-byte the shape build-manifest.mjs emits (2-space JSON.stringify,
// fixed key order). The installer parses it with awk, so a layout change here
// or there breaks the pair — release-manifest.test.ts asserts the generator
// side of the same contract.
const MANIFEST_SHA =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const manifestJson = (
    opts: { version?: string; channel?: string; target?: string } = {}
): string => {
    const version = opts.version ?? '9.9.9'
    const target = opts.target ?? platformTarget()
    return JSON.stringify(
        {
            schema: 1,
            channel: opts.channel ?? 'stable',
            version,
            commit: '923abd1a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11',
            commitShort: '923abd1',
            buildTime: '2026-08-24T08:22:41Z',
            publishedAt: '2026-08-24T08:30:12Z',
            tag: `cli-v${version}`,
            artifacts: {
                [target]: {
                    url: `https://release.invalid/download/cli-v${version}/mf-${version}-${target}.tar.gz`,
                    sha256: MANIFEST_SHA,
                    size: 123,
                    format: 'tar.gz',
                    binary: 'mf'
                }
            }
        },
        null,
        2
    )
}

const executable = async (path: string, source: string): Promise<void> => {
    await writeFile(path, source, { mode: 0o755 })
}

const createHarness = async (): Promise<InstallerHarness> => {
    const root = await mkdtemp(join(tmpdir(), 'mf-installer-'))
    const binDir = join(root, 'bin')
    const installDir = join(root, 'install')
    const fakeMf = join(root, 'fake-mf')
    const argsFile = join(root, 'args')
    const curlLog = join(root, 'curl.log')
    const installScript = await readFile(installerUrl, 'utf8')
    await mkdir(binDir)

    await executable(
        join(binDir, 'curl'),
        `#!/bin/sh
set -eu
printf '%s\n' "$*" >>"$MF_TEST_CURL_LOG"
out=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift 2 ;;
        *) shift ;;
    esac
done
if [ -n "$out" ]; then
    : >"$out"
else
    printf '%s\n' "$MF_TEST_MANIFEST_JSON"
fi
`
    )
    await executable(
        join(binDir, 'shasum'),
        `#!/bin/sh
# The installer compares this against the manifest's sha256, so a bare exit 0
# would no longer prove anything.
printf '%s  archive\n' "\${MF_TEST_SHA256:-$MF_TEST_MANIFEST_SHA}"
`
    )
    await executable(
        join(binDir, 'tar'),
        `#!/bin/sh
set -eu
dest=''
while [ "$#" -gt 0 ]; do
    case "$1" in
        -C) dest=$2; shift 2 ;;
        *) shift ;;
    esac
done
[ -n "$dest" ]
cp "$MF_TEST_FAKE_MF" "$dest/mf"
`
    )
    await executable(
        fakeMf,
        `#!/bin/sh
set -eu
if [ "\${1:-}" = '--version' ]; then
    printf '%s\n' "$MF_TEST_INSTALLED_VERSION"
    exit 0
fi
printf '%s\n' "$@" >"$MF_TEST_ARGS_FILE"
if [ -t 0 ]; then
    printf 'mf-stdin:tty\n'
else
    printf 'mf-stdin:notty\n'
fi
`
    )

    return {
        env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            VERSION: '9.9.9',
            MF_INSTALL_DIR: installDir,
            MF_TEST_ARGS_FILE: argsFile,
            MF_TEST_CURL_LOG: curlLog,
            MF_TEST_FAKE_MF: fakeMf,
            MF_TEST_INSTALLED_VERSION: '9.9.9',
            MF_TEST_MANIFEST_JSON: manifestJson(),
            MF_TEST_MANIFEST_SHA: MANIFEST_SHA
        },
        installDir,
        installScript,
        root
    }
}

test('installer forwards args without logging secrets', async () => {
    const harness = await createHarness()
    try {
        const secret = 'mfs_do_not_log'
        const result = spawnSync(
            'sh',
            ['-s', '--', 'setup', '--token', secret],
            {
                encoding: 'utf8',
                env: harness.env,
                input: harness.installScript
            }
        )
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /install: running installed mf/)
        assert.doesNotMatch(result.stdout, new RegExp(secret))
        assert.deepEqual(
            (await readFile(harness.env.MF_TEST_ARGS_FILE!, 'utf8'))
                .trimEnd()
                .split('\n'),
            ['setup', '--token', secret]
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer skips archive downloads for an already-installed target version', async () => {
    const harness = await createHarness()
    try {
        await mkdir(harness.installDir)
        const installedMf = join(harness.installDir, 'mf')
        await copyFile(harness.env.MF_TEST_FAKE_MF!, installedMf)
        await chmod(installedMf, 0o755)
        const env = { ...harness.env }
        delete env.VERSION

        const result = spawnSync('sh', ['-s', '--', 'setup'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /already installed: .*skipping download/)
        assert.deepEqual(
            (await readFile(harness.env.MF_TEST_ARGS_FILE!, 'utf8'))
                .trimEnd()
                .split('\n'),
            ['setup']
        )
        const curlCalls = (
            await readFile(harness.env.MF_TEST_CURL_LOG!, 'utf8')
        )
            .trimEnd()
            .split('\n')
        assert.equal(curlCalls.length, 1)
        assert.match(
            curlCalls[0],
            /\/releases\/download\/cli-channels\/stable\.json(?:$| )/
        )
        assert.doesNotMatch(curlCalls[0], /(?:^| )-o(?: |$)/)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer downloads when the target version is outdated', async () => {
    const harness = await createHarness()
    try {
        await mkdir(harness.installDir)
        const installedMf = join(harness.installDir, 'mf')
        await executable(installedMf, "#!/bin/sh\nprintf '9.9.8\\n'\n")

        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env: harness.env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /install: downloading/)
        const curlCalls = (
            await readFile(harness.env.MF_TEST_CURL_LOG!, 'utf8')
        )
            .trimEnd()
            .split('\n')
        // Two, not three: the checksum rides inside the manifest, so there is
        // no separate .sha256 request that could be answered from a different
        // cache generation than the archive.
        assert.equal(curlCalls.length, 2)
        assert.match(
            curlCalls[0],
            /\/releases\/download\/cli-v9\.9\.9\/manifest\.json(?:$| )/,
            'VERSION pins that release\'s own manifest'
        )
        assert.doesNotMatch(curlCalls[0], /(?:^| )-o(?: |$)/)
        assert.match(curlCalls[1], /(?:^| )-o(?: |$)/)
        assert.match(curlCalls[1], /mf-9\.9\.9-.*\.tar\.gz/)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer resolves the dev channel pointer', async () => {
    const harness = await createHarness()
    try {
        const env: NodeJS.ProcessEnv = {
            ...harness.env,
            MF_CHANNEL: 'dev'
        }
        delete env.VERSION
        env.MF_TEST_MANIFEST_JSON = manifestJson({ channel: 'dev' })
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /channel=dev/)
        const calls = (await readFile(harness.env.MF_TEST_CURL_LOG!, 'utf8'))
            .trimEnd()
            .split('\n')
        assert.match(
            calls[0],
            /\/releases\/download\/cli-channels\/dev\.json(?:$| )/
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

// Binaries installed before the rename were versioned `-staging.`, and the
// hosted installer took MF_CHANNEL=staging; both must keep working.
test('installer accepts staging as the pre-rename alias for dev', async () => {
    const harness = await createHarness()
    try {
        const env: NodeJS.ProcessEnv = {
            ...harness.env,
            MF_CHANNEL: 'staging'
        }
        delete env.VERSION
        env.MF_TEST_MANIFEST_JSON = manifestJson({ channel: 'dev' })
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /channel=dev/)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer pins a dev version inside the rolling dev release', async () => {
    const harness = await createHarness()
    try {
        const version = '9.9.9-dev.202608240920.a72f4de'
        const env: NodeJS.ProcessEnv = { ...harness.env, VERSION: version }
        env.MF_TEST_MANIFEST_JSON = manifestJson({ version, channel: 'dev' })
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        const calls = (await readFile(harness.env.MF_TEST_CURL_LOG!, 'utf8'))
            .trimEnd()
            .split('\n')
        assert.match(
            calls[0],
            new RegExp(`/releases/download/cli-dev/manifest-${version}\\.json(?:$| )`)
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer rejects an unknown channel', async () => {
    const harness = await createHarness()
    try {
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env: { ...harness.env, MF_CHANNEL: 'beta' },
            input: harness.installScript
        })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /unknown channel 'beta'/)
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer aborts on a sha256 mismatch and leaves any existing binary alone', async () => {
    const harness = await createHarness()
    try {
        await mkdir(harness.installDir)
        const installedMf = join(harness.installDir, 'mf')
        await executable(installedMf, "#!/bin/sh\nprintf '9.9.8\\n'\n")

        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env: { ...harness.env, MF_TEST_SHA256: 'f'.repeat(64) },
            input: harness.installScript
        })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /sha256 mismatch/)
        // The pre-existing binary must survive a failed install.
        assert.match(
            await readFile(installedMf, 'utf8'),
            /printf '9\.9\.8/
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer errors when the channel has no build for this platform', async () => {
    const harness = await createHarness()
    try {
        const env = { ...harness.env }
        delete env.VERSION
        env.MF_TEST_MANIFEST_JSON = manifestJson({ target: 'solaris-sparc' })
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.notEqual(result.status, 0)
        assert.match(
            result.stderr,
            new RegExp(`no ${platformTarget()} build for 9\\.9\\.9`)
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

// The awk extractors depend on build-manifest.mjs's exact 2-space layout. Feed
// them the REAL generator output so a formatting change on either side fails
// here instead of in production.
test('installer awk extractors read real build-manifest.mjs output', async () => {
    const harness = await createHarness()
    try {
        const assetDir = join(harness.root, 'dist-bin')
        await mkdir(assetDir)
        for (const target of [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64',
            'linux-x64'
        ])
            await writeFile(join(assetDir, `mf-9.9.9-${target}.tar.gz`), target)
        await writeFile(join(assetDir, 'mf-9.9.9-windows-x64.zip'), 'win')
        const manifestPath = join(harness.root, 'manifest.json')
        const generated = spawnSync(
            process.execPath,
            [
                new URL('../scripts/build-manifest.mjs', import.meta.url)
                    .pathname,
                '--channel', 'stable',
                '--version', '9.9.9',
                '--commit', '923abd1a4f2c8e0b6d5f1a90c3e77b2d4f8a0e11',
                '--tag', 'cli-v9.9.9',
                '--dir', assetDir,
                '--base', 'https://release.invalid/download/cli-v9.9.9',
                '--out', manifestPath
            ],
            { encoding: 'utf8' }
        )
        assert.equal(generated.status, 0, generated.stderr)
        const manifest = await readFile(manifestPath, 'utf8')
        const expectedSha = JSON.parse(manifest).artifacts[platformTarget()]
            .sha256

        const env = { ...harness.env }
        delete env.VERSION
        env.MF_TEST_MANIFEST_JSON = manifest
        env.MF_TEST_SHA256 = expectedSha
        const result = spawnSync('sh', ['-s'], {
            encoding: 'utf8',
            env,
            input: harness.installScript
        })
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /cli=9\.9\.9/)
        assert.match(
            result.stdout,
            new RegExp(`url=https://release\\.invalid/download/cli-v9\\.9\\.9/mf-9\\.9\\.9-${platformTarget()}\\.tar\\.gz`)
        )
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer reconnects forwarded commands to the controlling terminal', async (t) => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        t.skip(
            'pseudo-terminal test only runs on supported installer platforms'
        )
        return
    }
    const available = spawnSync('sh', ['-c', 'command -v script'], {
        encoding: 'utf8'
    })
    if (available.status !== 0) {
        t.skip('script utility is unavailable')
        return
    }

    const harness = await createHarness()
    try {
        const installerPath = join(harness.root, 'install.sh')
        await writeFile(installerPath, harness.installScript)
        const env = {
            ...harness.env,
            MF_TEST_INSTALLER: installerPath
        }
        const command = 'cat "$MF_TEST_INSTALLER" | sh -s -- setup'
        const args =
            process.platform === 'darwin'
                ? ['-q', '/dev/null', 'sh', '-c', command]
                : ['-q', '-e', '-c', command, '/dev/null']
        const stdin = openSync('/dev/null', 'r')
        try {
            const result = spawnSync('script', args, {
                encoding: 'utf8',
                env,
                stdio: [stdin, 'pipe', 'pipe'],
                timeout: 10_000
            })
            assert.equal(result.status, 0, result.stderr)
            assert.match(result.stdout, /mf-stdin:tty/)
        } finally {
            closeSync(stdin)
        }
    } finally {
        await rm(harness.root, { recursive: true, force: true })
    }
})

test('installer environment examples assign variables to sh', async () => {
    const sources = [
        installerUrl,
        new URL('../README.md', import.meta.url),
        new URL('../../docs/src/content/docs/install.md', import.meta.url),
        new URL('../../docs/src/content/docs/zh/install.md', import.meta.url)
    ]
    const invalidAssignment =
        /(?:VERSION|MF_INSTALL_DIR|MF_CHANNEL)=\S+\s+curl\b[^\n]*\|\s*sh\b/
    for (const source of sources) {
        assert.doesNotMatch(await readFile(source, 'utf8'), invalidAssignment)
    }
})

// manyfold.ai/cli/install.sh is served straight out of the web app's public
// dir, and neither Dockerfile has apps/cli in scope — so this cannot be a
// build-time copy or a symlink. A committed duplicate plus this test is the
// same pattern readme-drift and help-drift already use.
test('the web-served installer is byte-identical to the canonical one', async () => {
    assert.equal(
        await readFile(installerUrl, 'utf8'),
        await readFile(
            new URL('../../web/public/cli/install.sh', import.meta.url),
            'utf8'
        ),
        'apps/web/public/cli/install.sh is stale — run:\n' +
            '  cp apps/cli/install.sh apps/web/public/cli/install.sh'
    )
})
