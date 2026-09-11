import { buildManagedPathScript } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildCliInstallScript,
    buildShellEnvBlock,
    buildShellEnvScript,
    cliInstallChannelForDeployEnv
} from '../src/modules/agent-self/sprite-shell-env.service'

test('host env installs before PATH without re-running retired migrations', () => {
    const script = buildShellEnvScript({
        apiBaseUrl: 'https://api.example/api'
    })
    assert.match(script, /export MF_API_URL=/)
    assert.match(script, /export MF_DEPLOY_ENV=/)
    assert.match(script, /\$HOME\/\.bashrc/)
    assert.match(script, /\$HOME\/\.profile/)
    assert.match(script, /\/etc\/profile\.d\/mf\.sh/)
    assert.ok(script.includes(buildManagedPathScript()))
    assert.ok(script.indexOf('mf-env-start') < script.indexOf('mf-path-start'))
    assert.doesNotMatch(
        script,
        /nca-env|remove_legacy|purge_identity|command -v nca/
    )
    assert.doesNotMatch(buildShellEnvBlock({}), /export PATH=/)
})

test('host env is sourceable with omitted or shell-sensitive configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-env-'))
    const envFile = join(dir, 'env.sh')
    try {
        for (const input of [
            {},
            { apiBaseUrl: "https://api.example/'literal", deployEnv: 'staging' }
        ]) {
            writeFileSync(envFile, buildShellEnvBlock(input))
            const output = execFileSync(
                'bash',
                [
                    '--noprofile',
                    '--norc',
                    '-c',
                    '. "$1"; printf "%s\\n%s\\n" "${MF_API_URL-}" "$MF_DEPLOY_ENV"',
                    'test',
                    envFile
                ],
                { encoding: 'utf8', env: { PATH: process.env.PATH } }
            )
            assert.deepEqual(output.trimEnd().split('\n'), [
                input.apiBaseUrl ?? '',
                input.deployEnv ?? 'local'
            ])
        }
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('runtime identity cannot enter a shared profile even through extra raw properties', () => {
    const input = {
        apiBaseUrl: 'https://api.example/api',
        agentId: 'agt_secret',
        apiToken: 'mft_secret'
    }
    for (const script of [
        buildShellEnvBlock(input),
        buildShellEnvScript(input)
    ]) {
        assert.doesNotMatch(
            script,
            /MF_API_TOKEN|MF_AGENT_ID|agt_secret|mft_secret/
        )
        assert.match(script, /export MF_API_URL='https:\/\/api.example\/api'/)
    }
})

test('CLI installers select their channel and preserve an explicit version', () => {
    for (const channel of ['stable', 'dev'] as const) {
        const script = buildCliInstallScript(channel, '0.34.0')
        assert.match(script, /https:\/\/manyfold\.ai\/cli\/install\.sh/)
        assert.match(script, /MF_INSTALL_DIR="\$HOME\/\.local\/bin"/)
        assert.match(script, /VERSION="0\.34\.0"/)
        assert.ok(script.includes(buildManagedPathScript()))
        assert.doesNotMatch(script, /purge_identity|nca-env/)
        if (channel === 'dev') {
            assert.match(
                script,
                /\| VERSION="0\.34\.0" MF_CHANNEL=dev MF_INSTALL_DIR=/
            )
            assert.match(script, /MF_DEV_CLI_OK/)
        } else {
            assert.doesNotMatch(script, /MF_CHANNEL/)
            assert.match(script, /MF_STABLE_CLI_OK/)
        }
    }
})

test('only the staging deployment selects the dev install channel', () => {
    assert.equal(cliInstallChannelForDeployEnv('staging'), 'dev')
    assert.equal(cliInstallChannelForDeployEnv('local'), 'stable')
    assert.equal(cliInstallChannelForDeployEnv('production'), 'stable')
})

test('generated host configuration and install scripts parse in sh and bash', () => {
    for (const script of [
        buildShellEnvScript({
            apiBaseUrl: "https://api.example/'literal",
            deployEnv: 'staging'
        }),
        buildShellEnvScript({}),
        buildCliInstallScript('stable'),
        buildCliInstallScript('dev', '0.34.0')
    ])
        for (const interpreter of ['bash', 'sh'])
            execFileSync(interpreter, ['-n'], { input: script })
})
