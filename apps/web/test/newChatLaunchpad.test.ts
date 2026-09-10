import test from 'node:test'
import assert from 'node:assert/strict'
import { tForLanguage } from '@manyfold/i18n'
import type { AgentFramework } from '@manyfold/shared'
import {
    NEW_CHAT_LAUNCHPAD_CONFIG,
    newChatLaunchpadConfigFor
} from '../src/lib/newChatLaunchpad'

const FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'hermes',
    'openclaw',
    'narranexus',
    'dify',
    'langflow',
    'a2a'
] as const

const configFor = (framework: AgentFramework) => {
    const config = newChatLaunchpadConfigFor(framework)
    assert.ok(config, `${framework} has no launchpad config`)
    return config
}

test('every framework has three unique starter prompts', () => {
    const promptSets = FRAMEWORKS.map((framework) => {
        const prompts = configFor(framework).promptKeys
        assert.equal(prompts.length, 3)
        return prompts.join('|')
    })

    assert.equal(new Set(promptSets).size, FRAMEWORKS.length)
})

test('the recommended action always leads the row order', () => {
    for (const framework of FRAMEWORKS) {
        const config = configFor(framework)
        assert.equal(
            config.recommended,
            config.actionIds[0],
            `${framework} badges a row the order does not lead with`
        )
    }
})

test('narranexus is never offered a schedule it cannot run', () => {
    // CreateAutomationModal filters narranexus out of its runnable agents, so
    // the row would open a form that silently targets a different agent.
    assert.ok(!configFor('narranexus').actionIds.includes('automation'))
})

test('an unknown framework costs the launchpad, not the chat page', () => {
    assert.equal(
        newChatLaunchpadConfigFor('mystery-framework' as AgentFramework),
        null
    )
})

test('framework actions respect supported capability boundaries', () => {
    assert.deepEqual(configFor('codex').actionIds, ['github', 'mcp', 'channel'])
    assert.deepEqual(configFor('hermes').actionIds, [
        'skills',
        'channel',
        'automation'
    ])
    assert.deepEqual(configFor('openclaw').actionIds, [
        'channel',
        'native',
        'automation'
    ])
    assert.deepEqual(configFor('dify').actionIds, [
        'provider',
        'channel',
        'automation'
    ])
    assert.deepEqual(configFor('a2a').actionIds, ['a2a'])
})

test('every launchpad string the UI renders resolves in English and Chinese', () => {
    const keys = new Set<string>([
        'web.chat.launchpad.heading',
        'web.chat.launchpad.tryTask',
        'web.chat.launchpad.workflowTitle',
        'web.chat.launchpad.recommended'
    ])
    // The component interpolates the action id into these two keys, so the
    // catalog key scan in i18nCompleteness cannot see them.
    for (const config of Object.values(NEW_CHAT_LAUNCHPAD_CONFIG)) {
        for (const prompt of config.promptKeys) keys.add(prompt)
        for (const id of config.actionIds) {
            keys.add(`web.chat.launchpad.actions.${id}.title`)
            keys.add(`web.chat.launchpad.actions.${id}.body`)
        }
    }
    for (const label of [
        'configure',
        'view',
        'connect',
        'create',
        'open',
        'check'
    ])
        keys.add(`web.chat.launchpad.actions.${label}`)

    const unresolved: string[] = []
    for (const language of ['en', 'zh'] as const)
        for (const key of keys)
            if (tForLanguage(language, key) === key)
                unresolved.push(`${language}: ${key}`)

    assert.deepEqual(unresolved, [])
})
