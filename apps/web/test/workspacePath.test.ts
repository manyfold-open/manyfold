import test from 'node:test'
import assert from 'node:assert/strict'
import type { SdkAgent } from '@manyfold/sdk'
import { workspaceDirNameOf, workspacePathOf } from '../src/lib/workspacePath'

const agent = (over: Partial<SdkAgent> = {}): SdkAgent =>
    ({
        workspacePath: null,
        mountPath: null,
        runtime: 'daemon',
        ...over
    }) as SdkAgent

test('falls back through workspacePath, mountPath, then a default', () => {
    assert.equal(
        workspacePathOf(agent({ workspacePath: '/home/me/code/app' })),
        '/home/me/code/app'
    )
    assert.equal(workspacePathOf(agent({ mountPath: '/mnt/work' })), '/mnt/work')
    assert.equal(workspacePathOf(agent()), '/workspace')
    // Whitespace-only is as good as absent.
    assert.equal(workspacePathOf(agent({ workspacePath: '   ' })), '/workspace')
})

test('the chip shows the directory name, not the path', () => {
    assert.equal(
        workspaceDirNameOf(
            agent({ workspacePath: '/Users/me/code/netmind-cloud-agents' })
        ),
        'netmind-cloud-agents'
    )
})

test('a trailing separator does not produce an empty name', () => {
    assert.equal(
        workspaceDirNameOf(agent({ workspacePath: '/home/me/project/' })),
        'project'
    )
    assert.equal(
        workspaceDirNameOf(agent({ workspacePath: '/home/me/project///' })),
        'project'
    )
})

test('a windows-style path splits on either separator', () => {
    assert.equal(
        workspaceDirNameOf(agent({ workspacePath: 'C:\\Users\\me\\app' })),
        'app'
    )
    assert.equal(
        workspaceDirNameOf(agent({ workspacePath: 'C:\\Users\\me\\app\\' })),
        'app'
    )
})

test('the filesystem root has no name to show', () => {
    assert.equal(workspaceDirNameOf(agent({ workspacePath: '/' })), null)
    assert.equal(workspaceDirNameOf(agent({ workspacePath: '///' })), null)
})

test('a bare directory name is already the name', () => {
    assert.equal(workspaceDirNameOf(agent({ workspacePath: 'app' })), 'app')
})
