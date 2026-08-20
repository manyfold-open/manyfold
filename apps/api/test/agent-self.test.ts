import { buildManagedPathScript } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildCliInstallScript,
    buildLegacyShellResiduePurgeScript,
    buildShellEnvBlock,
    buildShellEnvScript,
    cliInstallChannelForDeployEnv
} from '../src/modules/agent-self/sprite-shell-env.service'

test('buildShellEnvScript embeds host env vars and uses block markers', () => {
    const script = buildShellEnvScript({
        agentId: 'agt_abc',
        apiBaseUrl: 'https://api.manyfold.ai/api'
    })
    assert.match(script, /export MF_API_URL=/)
    assert.match(script, /export MF_DEPLOY_ENV=/)
    assert.match(script, /mf-env-start/)
    assert.match(script, /mf-env-end/)
    assert.match(script, /\$HOME\/\.bashrc/)
    assert.match(script, /\$HOME\/\.profile/)
    assert.match(script, /\/etc\/profile\.d\/mf\.sh/)
    assert.match(script, /# nca-env-start/)
    assert.match(script, /remove_legacy_undefined_env_block/)
    assert.match(script, /\$0 == "undefined"/)
})

// PATH moved out of the env block into its own last-sorting managed block: this
// one is installed as /etc/profile.d/mf.sh, which the image's node fragment
// sorts after and clobbers (#611). Provisioning still owns both.
test('buildShellEnvScript installs the managed PATH block after the env block', () => {
    const script = buildShellEnvScript({
        agentId: 'agt_abc',
        apiBaseUrl: 'https://api.manyfold.ai/api'
    })
    assert.ok(script.includes(buildManagedPathScript()))
    assert.ok(script.indexOf('mf-env-start') < script.indexOf('mf-path-start'))
    assert.doesNotMatch(
        buildShellEnvBlock({ agentId: 'agt_abc' }),
        /export PATH=/
    )
})

test('buildShellEnvScript shell-escapes embedded single quotes', () => {
    const script = buildShellEnvScript({
        agentId: 'agt_x',
        apiBaseUrl: "https://api.test/'odd"
    })
    // Single quotes inside an emitted value must be POSIX-escaped to '\''
    assert.match(script, /https:\/\/api\.test\/'\\''odd/)
})

test('buildShellEnvScript exports MF_DEPLOY_ENV and defaults to local', () => {
    const withDeployEnv = buildShellEnvScript({
        agentId: 'agt_abc',
        apiBaseUrl: 'https://api.example.com/api',
        deployEnv: 'staging'
    })
    assert.match(withDeployEnv, /export MF_DEPLOY_ENV='staging'/)
    const withoutDeployEnv = buildShellEnvScript({
        agentId: 'agt_abc',
        apiBaseUrl: 'https://api.manyfold.ai/api'
    })
    assert.match(withoutDeployEnv, /export MF_DEPLOY_ENV='local'/)
    assert.doesNotMatch(
        buildShellEnvBlock({
            agentId: 'agt_abc',
            apiBaseUrl: 'https://api.example.com/api',
            deployEnv: 'staging'
        }),
        /\bundefined\b/
    )
    assert.doesNotMatch(
        buildShellEnvBlock({
            agentId: 'agt_abc',
            apiBaseUrl: 'https://api.manyfold.ai/api'
        }),
        /\bundefined\b/
    )
})

test('buildShellEnvBlock stays sourceable when API URL is omitted', () => {
    const block = buildShellEnvBlock({
        agentId: "agt_o'malley"
    })
    assert.doesNotMatch(block, /\bundefined\b/)
    assert.doesNotMatch(block, /MF_API_URL/)

    // Source the block from a temp file rather than `. /dev/stdin`: piping the
    // block to bash's stdin breaks on Linux CI runners ("/dev/stdin: No such
    // device or address") while still wanting to prove the block sources clean.
    const dir = mkdtempSync(join(tmpdir(), 'mf-env-'))
    const envFile = join(dir, 'env.sh')
    writeFileSync(envFile, block)
    try {
        const out = execFileSync(
            'bash',
            [
                '--noprofile',
                '--norc',
                '-c',
                [
                    'set -eu',
                    'HOME=/tmp/manyfold-test-home',
                    `. "${envFile}"`,
                    'printf "%s\\n" "$MF_DEPLOY_ENV"'
                ].join('; ')
            ],
            { encoding: 'utf8' }
        )
        assert.deepEqual(out.trimEnd().split('\n'), ['local'])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('buildShellEnvBlock never bakes the per-agent token or agent id into the shared profile', () => {
    const block = buildShellEnvBlock({
        agentId: 'agt_A',
        apiBaseUrl: 'https://api.manyfold.ai/api',
        apiToken: 'nca_rt_secret'
    })
    // Identity (MF_API_TOKEN + MF_AGENT_ID) is injected per-exec; the shared
    // sandbox VM profile carries only host-level env so co-resident agents never
    // clash on a single identity.
    assert.doesNotMatch(block, /MF_API_TOKEN/)
    assert.doesNotMatch(block, /MF_AGENT_ID/)
    assert.match(block, /export MF_API_URL='https:\/\/api.manyfold.ai\/api'/)
})

test('buildShellEnvBlock omits MF_API_TOKEN when API URL is absent (gate)', () => {
    const block = buildShellEnvBlock({
        agentId: 'agt_A',
        apiToken: 'nca_rt_secret'
    })
    assert.doesNotMatch(block, /MF_API_TOKEN/)
    assert.doesNotMatch(block, /MF_API_URL/)
})

test('buildShellEnvBlock omits MF_API_TOKEN when no token is provided', () => {
    const block = buildShellEnvBlock({
        agentId: 'agt_A',
        apiBaseUrl: 'https://api.manyfold.ai/api'
    })
    assert.doesNotMatch(block, /MF_API_TOKEN/)
    assert.match(block, /MF_API_URL/)
})

test('buildCliInstallScript installs the staging channel over ~/.local/bin/mf', () => {
    const script = buildCliInstallScript('staging')
    assert.match(
        script,
        /https:\/\/cdn1\.manyfold\.ai\/cli\/staging\/install\.sh/
    )
    assert.match(script, /MF_INSTALL_DIR="\$HOME\/\.local\/bin"/)
    assert.match(script, /"\$HOME\/\.local\/bin\/mf" --version/)
    assert.match(script, /MF_STAGING_CLI_OK/)
})

test('buildCliInstallScript installs the default channel over ~/.local/bin/mf', () => {
    const script = buildCliInstallScript('stable')
    assert.match(script, /https:\/\/cdn1\.manyfold\.ai\/cli\/install\.sh/)
    assert.match(script, /MF_INSTALL_DIR="\$HOME\/\.local\/bin"/)
    assert.match(script, /"\$HOME\/\.local\/bin\/mf" --version/)
    assert.match(script, /MF_STABLE_CLI_OK/)
})

test('buildCliInstallScript picks exact channel URLs', () => {
    assert.doesNotMatch(
        buildCliInstallScript('stable'),
        /cli\/staging\/install\.sh/
    )
    assert.match(buildCliInstallScript('staging'), /cli\/staging\/install\.sh/)
})

test('cliInstallChannelForDeployEnv maps only staging to staging CLI', () => {
    assert.equal(cliInstallChannelForDeployEnv('staging'), 'staging')
    assert.equal(cliInstallChannelForDeployEnv('local'), 'stable')
    assert.equal(cliInstallChannelForDeployEnv('production'), 'stable')
})

// #650: the residue is in world-readable, always-sourced files that no marker
// can reach, so the cleanup has to name the files it sweeps — including the
// pre-rename /etc/profile.d/nca.sh, where the drill found a co-resident
// agent's live token at mode 0644.
test('the reconcile sweeps every shared shell file a managed write reached', () => {
    const script = buildLegacyShellResiduePurgeScript()
    for (const target of [
        '"$HOME/.bashrc"',
        '"$HOME/.profile"',
        '"$HOME/.zshrc"',
        '"$HOME/.bash_profile"',
        '"$HOME/.bash_login"',
        '"$HOME/.zprofile"',
        '/etc/profile.d/mf.sh',
        '/etc/profile.d/nca.sh'
    ])
        assert.ok(script.includes(target), `${target} is not swept`)
})

// nca.sh is root-owned and mode 0644; a rewrite that renamed a fresh temp file
// over it would hand it the umask's mode and could stop an agent shell from
// reading the managed env at all.
test('the purge rewrites through the original file, preserving mode', () => {
    const script = buildLegacyShellResiduePurgeScript()
    assert.match(script, /cat "\$mf_purge_tmp" > "\$mf_purge_file"/)
    assert.doesNotMatch(script, /mv .*"\$mf_purge_file"/)
})

// Both surfaces that reach an already-provisioned sprite have to carry it, or
// the sweep only ever lands on sandboxes that re-provision (#650 AC-2).
test('provision and CLI upgrade both carry the residue purge', () => {
    const provision = buildShellEnvScript({
        agentId: 'agt_abc',
        apiBaseUrl: 'https://api.manyfold.ai/api'
    })
    assert.ok(provision.includes(buildLegacyShellResiduePurgeScript()))
    for (const channel of ['stable', 'staging'] as const)
        assert.ok(
            buildCliInstallScript(channel).includes(
                buildLegacyShellResiduePurgeScript()
            )
        )
})

test('every generated shell-env script is valid POSIX sh and bash', () => {
    const scripts = [
        buildShellEnvScript({
            agentId: "agt_o'malley",
            apiBaseUrl: 'https://api.manyfold.ai/api',
            apiToken: 'mft_secret',
            deployEnv: 'staging'
        }),
        buildShellEnvScript({ agentId: 'agt_abc' }),
        buildCliInstallScript('stable'),
        buildCliInstallScript('staging', '1.2.3'),
        buildLegacyShellResiduePurgeScript()
    ]
    for (const script of scripts)
        for (const interpreter of ['bash', 'sh'])
            execFileSync(interpreter, ['-n'], { input: script })
})
