import assert from 'node:assert/strict'
import test from 'node:test'
import { t, tForLanguage } from '@manyfold/i18n'
import { DEFAULT_CLI_API_URL } from '@manyfold/shared'
import {
    agentSetupTarget,
    buildAgentSetupPrompt
} from '../src/lib/agentSetupPrompt'

test('production gets the one-line prompt and nothing else', () => {
    const target = agentSetupTarget(DEFAULT_CLI_API_URL)
    assert.deepEqual(target, {
        guideUrl: 'https://api.manyfold.ai/api/agent-setup.md',
        host: 'api.manyfold.ai',
        local: false,
        production: true
    })
    assert.equal(
        buildAgentSetupPrompt(t, target),
        'Connect this agent to Manyfold: fetch https://api.manyfold.ai/api/agent-setup.md with `curl` and follow it to the end.'
    )
})

// Outside production the agent must not sign the user's existing mf profile
// in to a different deployment, so the prompt says where it is connecting.
test('a local dev stack is named as one', () => {
    for (const apiBase of [
        'http://localhost:7180/api/',
        'http://127.0.0.1:7180/api'
    ]) {
        const target = agentSetupTarget(apiBase)
        assert.equal(target.local, true, apiBase)
        const prompt = buildAgentSetupPrompt(t, target)
        assert.match(
            prompt,
            /fetch http:\/\/(localhost|127\.0\.0\.1):7180\/api\/agent-setup\.md with/
        )
        assert.match(
            prompt,
            /This is my local Manyfold dev stack at (localhost|127\.0\.0\.1):7180: use a separate `mf` profile/
        )
    }
})

test('any other deployment is named by its API host', () => {
    const prompt = buildAgentSetupPrompt(
        t,
        agentSetupTarget('https://api.example.com/api')
    )
    assert.match(
        prompt,
        /fetch https:\/\/api\.example\.com\/api\/agent-setup\.md/
    )
    assert.match(
        prompt,
        /This is the Manyfold deployment at api\.example\.com: use a separate `mf` profile/
    )
    assert.doesNotMatch(prompt, /local Manyfold dev stack/)
})

test('the prompt follows the interface language', () => {
    const zh = (key: string, params?: Record<string, string | number>) =>
        tForLanguage('zh', key, params)
    const prompt = buildAgentSetupPrompt(
        zh as typeof t,
        agentSetupTarget('http://localhost:7180/api')
    )
    assert.match(
        prompt,
        /^把这个 agent 接入 Manyfold：用 `curl` 读取 http:\/\/localhost:7180\/api\/agent-setup\.md /
    )
    assert.match(prompt, /这是我本地的 Manyfold 开发环境（localhost:7180）/)
})
