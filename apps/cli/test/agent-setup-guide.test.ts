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
    },
    {
        apiUrl: 'http://localhost:7110/api',
        webUrl: 'http://localhost:7111',
        cliChannel: 'stable',
        cliInstallUrl: CLI_INSTALL_URL
    }
]

// The checks in step 1 call mf through "$bin" (the binary found or just
// installed), which markdownInvocations cannot see: a call starts a line or a
// $( ) substitution, and ends at the first separator.
const binInvocations = (markdown: string): string[][] =>
    [...markdown.matchAll(/(?:^\s*|\$\()"\$bin"\s+([^\n]+)/gm)].map((match) =>
        match[1]!
            .split(/\s*(?:;|&&|\|\||\||\))\s*/)[0]!
            .replace(/\s+\d*>{1,2}\s*\S+/g, '')
            .trim()
            .split(/\s+/)
    )

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

test('the checks the guide runs through "$bin" exist as written', () => {
    const program = buildProgram()
    for (const deployment of deployments) {
        const calls = binInvocations(renderAgentSetupGuide(deployment))
        for (const expected of [
            '--version',
            'profile list --json',
            'login --help'
        ])
            assert.ok(
                calls.some((argv) => argv.join(' ') === expected),
                `${deployment.apiUrl}: no "$bin" ${expected}`
            )
        for (const argv of calls)
            assert.doesNotThrow(
                () => validateCommandPath(program, argv),
                `${deployment.apiUrl}: stale CLI syntax: "$bin" ${argv.join(' ')}`
            )
    }
})
