import { DEFAULT_CLI_API_URL } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    daemonInstallCommand,
    daemonRegisterCommand,
    daemonSetupCommand
} from '../src/lib/daemonCommands'

// A fresh CLI defaults to the hosted API. On the hosted deployment that makes
// the flag noise; anywhere else its absence silently registers the machine
// against the wrong platform, and the command still looks right — which is why
// both halves are pinned here rather than only the one that changed.
const SELF_HOSTED = 'https://mf.example.com/api'

test('the hosted deployment leaves the commands as they were', () => {
    assert.equal(
        daemonSetupCommand(DEFAULT_CLI_API_URL),
        'curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup'
    )
    assert.equal(
        daemonInstallCommand('tok_1', DEFAULT_CLI_API_URL),
        'curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- daemon register --token tok_1 -y'
    )
    assert.equal(
        daemonRegisterCommand('tok_1', DEFAULT_CLI_API_URL),
        'mf daemon register --token tok_1 -y'
    )
})

test('every other deployment names itself in each command', () => {
    assert.equal(
        daemonSetupCommand(SELF_HOSTED),
        `curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- setup --api-url ${SELF_HOSTED}`
    )
    assert.equal(
        daemonInstallCommand('tok_1', SELF_HOSTED),
        `curl -fsSL https://manyfold.ai/cli/install.sh | sh -s -- daemon register --token tok_1 --api-url ${SELF_HOSTED} -y`
    )
    assert.equal(
        daemonRegisterCommand('tok_1', SELF_HOSTED),
        `mf daemon register --token tok_1 --api-url ${SELF_HOSTED} -y`
    )
})

// The flag has to sit before `-y`, not after the token it follows in the
// sentence: install.sh forwards the whole tail to the binary, and a value
// stranded after the confirm flag is parsed as a positional.
test('the url lands among the flags, ahead of the confirm flag', () => {
    const command = daemonInstallCommand('tok_1', SELF_HOSTED)
    assert.ok(command.includes('--api-url'))
    assert.ok(command.indexOf('--api-url') < command.indexOf(' -y'))
})
