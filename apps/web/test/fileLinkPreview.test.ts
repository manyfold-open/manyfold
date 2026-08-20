import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWorkspaceFileLink } from '../src/components/chat/fileLinkPreview'

const context = {
    mountPath: '/workspace',
    workspacePath: '/home/sprite/.nca/workspaces/agt_123'
}

test('resolves relative markdown links as workspace files', () => {
    assert.deepEqual(resolveWorkspaceFileLink('src/index.ts', context), {
        rootId: 'workspace',
        relPath: 'src/index.ts'
    })
    assert.deepEqual(resolveWorkspaceFileLink('./README.md#L12', context), {
        rootId: 'workspace',
        relPath: 'README.md'
    })
})

test('resolves absolute workspace aliases', () => {
    assert.deepEqual(
        resolveWorkspaceFileLink(
            '/home/sprite/.nca/workspaces/agt_123/apps/web/src/App.tsx',
            context
        ),
        {
            rootId: 'workspace',
            relPath: 'apps/web/src/App.tsx'
        }
    )
    assert.deepEqual(
        resolveWorkspaceFileLink('/workspace/package.json', context),
        {
            rootId: 'workspace',
            relPath: 'package.json'
        }
    )
})

test('strips line suffixes and decodes file URLs', () => {
    assert.deepEqual(
        resolveWorkspaceFileLink(
            'file:///home/sprite/.nca/workspaces/agt_123/src/My%20File.tsx:42:7',
            context
        ),
        {
            rootId: 'workspace',
            relPath: 'src/My File.tsx'
        }
    )
})

test('does not intercept external or escaping links', () => {
    assert.equal(
        resolveWorkspaceFileLink('https://example.com/a.ts', context),
        null
    )
    assert.equal(
        resolveWorkspaceFileLink('mailto:test@example.com', context),
        null
    )
    assert.equal(resolveWorkspaceFileLink('../outside.ts', context), null)
    assert.equal(resolveWorkspaceFileLink('/etc/passwd', context), null)
    assert.equal(resolveWorkspaceFileLink('#local-heading', context), null)
})
