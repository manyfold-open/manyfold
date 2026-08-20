import assert from 'node:assert/strict'
import test from 'node:test'
import {
    githubAvatarUrl,
    githubAvatarUrlFromRepositoryUrl
} from '../src/lib/githubAvatar'

test('skill cards use the GitHub owner avatar', () => {
    assert.equal(
        githubAvatarUrl('modelcontextprotocol'),
        'https://github.com/modelcontextprotocol.png?size=64'
    )
})

test('MCP GitHub homepages use the repository owner avatar', () => {
    assert.equal(
        githubAvatarUrlFromRepositoryUrl(
            'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
        ),
        'https://github.com/modelcontextprotocol.png?size=64'
    )
})

test('MCP non-GitHub homepages do not guess a GitHub account', () => {
    assert.equal(githubAvatarUrlFromRepositoryUrl('https://context7.com'), null)
})
