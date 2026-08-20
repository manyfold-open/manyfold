import test from 'node:test'
import assert from 'node:assert/strict'
import {
    MANYFOLD_CLI_USAGE_SKILL_ID,
    type AgentSkillsGroup,
    type InstalledSkillSummary,
    type SkillTargetAgentSummary
} from '@manyfold/shared'
import { shouldPromptFirstPartyInstall } from '../src/pages/Skills/firstPartySkill'

const skill = (skillId: string): InstalledSkillSummary =>
    ({ skillId }) as InstalledSkillSummary

const group = (
    skills: InstalledSkillSummary[],
    inventoryError?: string
): AgentSkillsGroup => ({
    agent: {} as SkillTargetAgentSummary,
    skills,
    inventoryError
})

test('prompts when the first-party skill is absent', () => {
    assert.equal(
        shouldPromptFirstPartyInstall(
            group([skill('github:other/repo@main:skills/x')])
        ),
        true
    )
})

test('prompts when the agent has no skills installed', () => {
    assert.equal(shouldPromptFirstPartyInstall(group([])), true)
})

test('does not prompt when the first-party skill is already installed', () => {
    assert.equal(
        shouldPromptFirstPartyInstall(
            group([skill(MANYFOLD_CLI_USAGE_SKILL_ID)])
        ),
        false
    )
})

test('does not prompt when the runtime inventory scan failed', () => {
    assert.equal(shouldPromptFirstPartyInstall(group([], 'scan failed')), false)
})

test('does not prompt before the group has loaded', () => {
    assert.equal(shouldPromptFirstPartyInstall(null), false)
})
