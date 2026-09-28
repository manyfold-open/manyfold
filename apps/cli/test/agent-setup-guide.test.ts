import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DEFAULT_CLI_API_URL,
    renderAgentSetupGuide,
    type AgentSetupGuideInput
} from '@manyfold/shared'
import { CLI_INSTALL_URL } from '../src/channel'
import { buildProgram } from '../src/program'
import { markdownInvocations, validateCommandPath } from './command-docs'

// Each deployment serves this guide at GET /api/agent-setup.md, and coding
// agents run its commands verbatim, so it is one more copy of the command
// tree: every mf command it prints has to exist with the options it passes.
const deployments: AgentSetupGuideInput[] = [
    {
        apiUrl: DEFAULT_CLI_API_URL,
        webUrl: 'https://manyfold.ai',
        cliChannel: 'stable',
        cliInstallUrl: CLI_INSTALL_URL
    },
    {
        apiUrl: 'https://api-staging.example.com/api',
        webUrl: 'https://app-staging.example.com',
        cliChannel: 'dev',
        cliInstallUrl: CLI_INSTALL_URL
    },
    {
        apiUrl: 'https://tunnel.example.com/api',
        requestedVia: 'http://localhost:7180/api',
        webUrl: 'http://localhost:7181',
        cliChannel: 'stable',
        cliInstallUrl: CLI_INSTALL_URL
    },
    {
        apiUrl: 'https://mf.example.org/api',
        cliChannel: 'stable',
        cliInstallUrl: CLI_INSTALL_URL
    }
]

test('every mf command in the agent setup guide exists as written', () => {
    const program = buildProgram()
    for (const deployment of deployments) {
        const invocations = markdownInvocations(
            renderAgentSetupGuide(deployment)
        )
        for (const command of ['login', 'whoami', 'profile', 'help'])
            assert.ok(
                invocations.some((invocation) =>
                    invocation.argv.includes(command)
                ),
                `${deployment.apiUrl}: no mf ${command} command found`
            )
        for (const invocation of invocations)
            assert.doesNotThrow(
                () => validateCommandPath(program, invocation.argv),
                `${deployment.apiUrl}: stale CLI syntax: ${invocation.source}`
            )
    }
})

test('the guide signs in with the two-step flag this CLI offers', () => {
    const guide = renderAgentSetupGuide(deployments[1]!)
    const signIn = markdownInvocations(guide).filter((invocation) =>
        invocation.argv.includes('--print-auth-url')
    )
    assert.equal(signIn.length, 1)
})
