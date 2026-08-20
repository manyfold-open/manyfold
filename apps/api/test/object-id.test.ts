import {
    ObjectIdResource,
    createObjectId,
    isObjectId,
    objectIdPrefixes,
    parseObjectId
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'

test('createObjectId emits registered prefix with 26 base32 chars', () => {
    for (const [resource, prefix] of Object.entries(objectIdPrefixes)) {
        const id = createObjectId(resource as ObjectIdResource)

        assert.match(id, new RegExp(`^${prefix}_[a-z2-7]{26}$`))
        assert.equal(isObjectId(id, resource as ObjectIdResource), true)
        assert.deepEqual(parseObjectId(id), {
            prefix,
            resource,
            unique: id.slice(prefix.length + 1)
        })
    }
})

test('object id prefixes are unique and preserve known values', () => {
    const prefixes = Object.values(objectIdPrefixes)

    assert.equal(new Set(prefixes).size, prefixes.length)
    assert.equal(objectIdPrefixes.agentRuntime, 'art')
    assert.equal(objectIdPrefixes.userModelProvider, 'ump')
    assert.equal(objectIdPrefixes.chatMessageSource, 'cms')
    assert.equal(objectIdPrefixes.userMcpServer, 'ums')
})

test('parseObjectId accepts valid unknown prefixes and rejects invalid ids', () => {
    const unknown = 'zzz_abcdefghijklmnopqrstuvwxyz'

    assert.equal(parseObjectId('abc_a'), null)
    assert.deepEqual(parseObjectId(unknown), {
        prefix: 'zzz',
        resource: null,
        unique: 'abcdefghijklmnopqrstuvwxyz'
    })
    assert.equal(isObjectId(unknown), true)
    assert.equal(isObjectId(unknown, 'agent'), false)
})
