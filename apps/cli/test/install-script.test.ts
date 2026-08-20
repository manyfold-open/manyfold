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

// The open-source installer resolves GitHub Releases: one API call for the
// release JSON, then the platform asset and its .sha256. The fake curl below
// serves the JSON when invoked without -o and writes empty files otherwise,
// so these tests pin the call shape (1 API read; downloads only when the
// installed version is outdated) without touching the network.

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

const releaseJson = (): string => {
    const asset = `https://release.invalid/download/v9.9.9/mf-9.9.9-${platformTarget()}.tar.gz`
    return JSON.stringify({
        tag_name: 'v9.9.9',
        assets: [
            { browser_download_url: asset },
            { browser_download_url: `${asset}.sha256` }
        ]
    })
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
    printf '%s\n' "$MF_TEST_RELEASE_JSON"
fi
`
    )
    await executable(join(binDir, 'shasum'), '#!/bin/sh\nexit 0\n')
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
            MF_TEST_RELEASE_JSON: releaseJson()
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
        assert.match(curlCalls[0], /\/releases\/latest(?:$| )/)
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
        assert.equal(curlCalls.length, 3)
        assert.match(
            curlCalls[0],
            /\/releases\/tags\/v9\.9\.9(?:$| )/,
            'VERSION pins the tagged release'
        )
        assert.doesNotMatch(curlCalls[0], /(?:^| )-o(?: |$)/)
        assert.ok(
            curlCalls
                .slice(1)
                .every((call) => /(?:^| )-o(?: |$)/.test(call)),
            'outdated install should download the archive and checksum'
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
