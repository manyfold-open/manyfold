import {
    AgentSkillsGroup,
    MANYFOLD_CLI_USAGE_SKILL_ID
} from '@manyfold/shared'

export const shouldPromptFirstPartyInstall = (
    group: AgentSkillsGroup | null
): boolean => {
    if (!group || group.inventoryError) return false
    return !group.skills.some(
        (skill) => skill.skillId === MANYFOLD_CLI_USAGE_SKILL_ID
    )
}
