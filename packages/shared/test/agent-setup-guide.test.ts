import test from 'node:test'
import assert from 'node:assert/strict'
import { renderAgentSetupGuide } from '../src/agentSetupGuide'
import { DEFAULT_CLI_API_URL } from '../src/cliVersion'

const INSTALL_URL = 'https://manyfold.ai/cli/install.sh'

test('the default API guide lets the agent pick the profile it already has', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: DEFAULT_CLI_API_URL,
        webUrl: 'https://manyfold.ai',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /- Web app: `https:\/\/manyfold\.ai`/)
    assert.match(guide, /^mf profile list --json$/m)
    assert.match(guide, /^mf profile show default --json$/m)
    assert.match(
        guide,
        /^mf --profile <profile> --api-url 'https:\/\/api\.manyfold\.ai\/api' whoami --json$/m
    )
    assert.match(
        guide,
        /^curl -fsSL https:\/\/manyfold\.ai\/cli\/install\.sh \| sh$/m
    )
    assert.doesNotMatch(guide, /MF_CHANNEL/)
})

test('another deployment gets its own profile and never the default one', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://api.example.com/api',
        webUrl: 'https://app.example.com',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /- CLI profile: `example-com`/)
    assert.match(
        guide,
        /^nohup mf --profile example-com --api-url 'https:\/\/api\.example\.com\/api' login --json > "\$log" 2>&1 &$/m
    )
    assert.doesNotMatch(guide, /--profile default/)
    assert.doesNotMatch(guide, /<profile>/)
})

// Seen on a local stack [2026-09-28]: a headless Claude Code run told the user
// to approve, polled for a minute, then ended its turn asking to be told when
// done, so the login it had started timed out unattended.
test('the browser approval is an active wait, not the end of the turn', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://api.example.com/api',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /part of this step, not the end of your turn/)
    assert.match(guide, /Do not ask the user to tell you when they are done/)
})

// Seen on a local stack [2026-09-28]: after a fresh install the agent ran
// "$HOME/.local/bin/mf" but handed off a message that said plain `mf`.
test('the hand-off message carries the command the agent actually ran', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: DEFAULT_CLI_API_URL,
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /put its full path from step 1 in place of `mf`/)
    assert.match(guide, /replace `<profile>` with the profile from step 2/)
})

// install.sh reads MF_CHANNEL and MF_INSTALL_DIR itself, so they must be set
// on `sh`, not on `curl` (apps/cli/test/install-script.test.ts).
test('the dev channel installs a private copy and hands off its path', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://api-staging.example.com/api',
        webUrl: 'https://app-staging.example.com',
        cliChannel: 'dev',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(
        guide,
        /^curl -fsSL \S+ \| MF_CHANNEL=dev MF_INSTALL_DIR="\$HOME\/\.local\/share\/manyfold\/dev\/bin" sh$/m
    )
    assert.doesNotMatch(guide, /MF_\w+=\S+ curl/)
    assert.match(
        guide,
        /through `"\$HOME\/\.local\/share\/manyfold\/dev\/bin\/mf" --profile staging-example-com --api-url 'https:\/\/api-staging\.example\.com\/api'` \(web app: https:\/\/app-staging\.example\.com\)/
    )
})

test('the guide names the API to use when it was fetched elsewhere', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://tunnel.example.com/api',
        requestedVia: 'http://localhost:7180/api',
        webUrl: 'http://localhost:7181',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(
        guide,
        /You fetched this guide through `http:\/\/localhost:7180\/api`, but this deployment's API is `https:\/\/tunnel\.example\.com\/api`/
    )
    const same = renderAgentSetupGuide({
        apiUrl: 'https://api.example.com/api',
        requestedVia: 'https://api.example.com/api',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.doesNotMatch(same, /You fetched this guide through/)
})

test('an unpublished web app URL is asked for, never guessed', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: 'https://mf.example.org/api',
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /- Web app: not published by this deployment/)
    assert.doesNotMatch(guide, /\(web app:/)
})

test('the API URL is single-quoted wherever a command carries it', () => {
    const guide = renderAgentSetupGuide({
        apiUrl: "https://mf.example.org/it's/api",
        cliChannel: 'stable',
        cliInstallUrl: INSTALL_URL
    })
    assert.match(guide, /--api-url 'https:\/\/mf\.example\.org\/it'\\''s\/api'/)
    for (const line of guide
        .split('\n')
        .filter((l) => l.includes('--api-url ')))
        assert.match(line, /--api-url '/, line)
})
