import assert from 'node:assert/strict'
import test from 'node:test'
import {
    isCodingHostFramework,
    setUpHostFramework,
    type SessionScriptRunner
} from '../src/modules/agents/bootstrap/host-framework-setup'

// A hosted machine installs agy on demand like the other coding CLIs (ADR-0035):
// its directories, the pinned release binary checked against its digest, and
// a version check that runs with agy's self-updater off.
test('a hosted machine sets up Antigravity CLI from its release binary', async () => {
    assert.equal(isCodingHostFramework('antigravity-cli'), true)
    const runs: Array<{ script: string; env?: Record<string, string> }> = []
    let installed = false
    const runner: SessionScriptRunner = {
        run: async (script, _timeoutMs, env) => {
            runs.push({ script, env })
            if (script.includes('releases/download/')) installed = true
            const probe = script.includes('agy --version')
            return {
                exitCode: 0,
                stdout: probe && installed ? '1.2.11\n' : '',
                stderr: ''
            }
        },
        warn: () => undefined
    }
    const result = await setUpHostFramework({
        runner,
        framework: 'antigravity-cli',
        workspaceBase: '/home/node/.manyfold/workspaces',
        credentials: {},
        modelConfigSource: 'runtime-local',
        install: {
            frameworkVersion: '1.2.11',
            frameworkVersionSource: 'latest',
            frameworkArtifacts: {
                x86_64: 'a'.repeat(64),
                aarch64: 'b'.repeat(64)
            }
        }
    })
    assert.equal(result.frameworkVersion, '1.2.11')
    assert.match(runs[0].script, /mkdir -p "\$HOME\/\.gemini\/antigravity-cli"/)
    assert.ok(
        runs.some((r) =>
            r.script.includes(
                'github.com/google-antigravity/antigravity-cli/releases/download/1.2.11/'
            )
        )
    )
    const verify = runs.at(-1)!
    assert.equal(verify.script, 'agy --version')
    assert.equal(verify.env?.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
})
