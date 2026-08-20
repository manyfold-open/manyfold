import assert from 'node:assert/strict'
import test from 'node:test'
import { t } from '@manyfold/i18n'
import { getToolConfig } from '../src/components/chat/tools/configs/toolConfigs'

test('renders Codex command_execution with terminal command summary', () => {
    const cfg = getToolConfig('command_execution')
    const command = '/bin/zsh -lc "rg --files apps/web"'

    assert.equal(cfg.icon, 'terminal')
    assert.equal(cfg.input.type, 'one-line')
    assert.equal(cfg.result?.contentType, 'terminal')
    assert.equal(cfg.input.getSummary?.({ command }, t), command)
})

test('renders Claude Code Agent with task summary', () => {
    const cfg = getToolConfig('Agent')

    assert.equal(cfg.icon, 'task')
    assert.equal(cfg.input.type, 'collapsible')
    assert.equal(
        cfg.input.getSummary?.(
            {
                prompt: 'Explore the workspace and report findings',
                description: 'Explore chat view rendering logic',
                subagent_type: 'Explore'
            },
            t
        ),
        'Explore chat view rendering logic'
    )
    assert.equal(
        cfg.input.getSummary?.(
            {
                prompt: 'Explore the workspace and report findings',
                subagent_type: 'Explore'
            },
            t
        ),
        'Explore: Explore the workspace and report findings'
    )
})
