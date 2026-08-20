import test from 'node:test'
import assert from 'node:assert/strict'
import { createObjectId } from '@manyfold/shared'
import { parseShareRef } from '../src/commands/skills/index'

test('parseShareRef accepts a bare lss_ id', () => {
    const id = createObjectId('librarySkillShare')
    assert.equal(parseShareRef(id), id)
    assert.equal(parseShareRef(`  ${id}  `), id)
})

test('parseShareRef extracts the id from a share URL on any origin', () => {
    const id = createObjectId('librarySkillShare')
    assert.equal(
        parseShareRef(`https://manyfold.ai/skills/shared/${id}`),
        id
    )
    assert.equal(
        parseShareRef(`https://app.my-deploy.example/skills/shared/${id}/`),
        id
    )
    assert.equal(
        parseShareRef(`http://localhost:3002/skills/shared/${id}`),
        id
    )
})

test('parseShareRef rejects other ids, paths and garbage', () => {
    const skillId = createObjectId('librarySkill')
    for (const value of [
        skillId,
        `https://manyfold.ai/skills/shared/${skillId}`,
        'https://manyfold.ai/skills/library',
        'https://manyfold.ai/skills/shared/',
        'not-a-share',
        ''
    ])
        assert.throws(
            () => parseShareRef(value),
            /share link .*or a bare lss_/
        )
})
