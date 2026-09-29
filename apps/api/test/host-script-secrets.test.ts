import assert from 'node:assert/strict'
import test from 'node:test'
import {
    applyCodexCredentials,
    sessionScriptRunner,
    secretFileStep
} from '../src/modules/agents/bootstrap/host-framework-setup'
import { podServiceRecipe } from '../src/modules/agent-runtimes/provisioning/pod-service-frameworks'

// A machine's scripts run through its daemon, which keeps every command's stdin in
// its exec buffer on disk (for 1–24h) but never its env. So a secret a script
// needs rides the exec's env, and a file holding one is decoded from there.

const SECRET = 'fixture-provider-key-value'

interface Recorded {
    cmd: string[]
    stdin?: string
    env?: Record<string, string>
}

const recordingRunner = () => {
    const execs: Recorded[] = []
    const runner = sessionScriptRunner(
        {
            run: async (req) => {
                execs.push(req)
                return { exitCode: 0, stdout: '', stderr: '' }
            }
        },
        () => {}
    )
    return { execs, runner }
}

const decoded = (env: Record<string, string> | undefined, name: string) =>
    Buffer.from(env?.[name] ?? '', 'base64').toString('utf8')

test('a host script carries its env in the exec env, never in its stdin', async () => {
    const { execs, runner } = recordingRunner()

    await runner.run('echo "$TOKEN"', 1_000, { TOKEN: SECRET })

    assert.deepEqual(execs[0].cmd, ['bash', '-l', '-s'])
    assert.equal(execs[0].stdin, 'echo "$TOKEN"\n')
    assert.deepEqual(execs[0].env, { TOKEN: SECRET })
})

test('a secret file is decoded from the env into an owner-only file, never written from the script', () => {
    const step = secretFileStep("'/home/node/.app/config.json'", 'MF_APP_CONFIG_B64', `{"key":"${SECRET}"}`)

    assert.equal(step.script.includes(SECRET), false)
    assert.match(step.script, /umask 077/)
    assert.match(step.script, /printf '%s' "\$MF_APP_CONFIG_B64" \| base64 -d > '\/home\/node\/\.app\/config\.json'\.tmp/)
    assert.match(step.script, /mv -f '\/home\/node\/\.app\/config\.json'\.tmp '\/home\/node\/\.app\/config\.json'/)
    assert.equal(decoded(step.env, 'MF_APP_CONFIG_B64'), `{"key":"${SECRET}"}`)
})

test('the codex config rewrite keeps the Composio key out of its script', async () => {
    const { execs, runner } = recordingRunner()

    await applyCodexCredentials({ runner, composioKey: SECRET })

    assert.equal(execs.length, 1)
    assert.equal(execs[0].stdin?.includes(SECRET), false)
    assert.match(decoded(execs[0].env, 'MF_CODEX_CONFIG_B64'), new RegExp(SECRET))
})

test('openclaw writes its key-bearing config from the env', async () => {
    const { execs, runner } = recordingRunner()
    await podServiceRecipe('openclaw')!.configure(runner, {
        credentials: {
            modelProvider: 'anthropic',
            baseUrl: 'https://models.example.test',
            apiKey: SECRET,
            primaryModelName: 'model-x',
            gatewayToken: 'gw-kept'
        },
        envText: null,
        controlUiEnabled: false
    })
    assert.equal(execs.length, 1)
    assert.equal(execs[0].stdin?.includes(SECRET), false)
    assert.equal(execs[0].stdin?.includes('gw-kept'), false)
    assert.match(decoded(execs[0].env, 'MF_OPENCLAW_CONFIG_B64'), new RegExp(SECRET))
})

test('hermes writes its config from the env too', async () => {
    const { execs, runner } = recordingRunner()
    await podServiceRecipe('hermes')!.configure(runner, {
        credentials: {
            primaryModelProvider: 'anthropic',
            primaryModelApiKey: SECRET,
            primaryModelName: 'model-x'
        },
        envText: null,
        controlUiEnabled: false
    })
    assert.equal(execs.length, 1)
    assert.equal(execs[0].stdin?.includes('model-x'), false)
    assert.match(decoded(execs[0].env, 'MF_HERMES_CONFIG_B64'), /model-x/)
})
