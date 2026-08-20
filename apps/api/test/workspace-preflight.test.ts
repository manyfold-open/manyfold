import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import {
    assertWorkspaceProbeResult,
    isWorkspacePreflightUserError,
    normalizeWorkspacePathInput,
    resolveWorkspaceSelection,
    workspacePreflightScript
} from '../src/modules/agents/workspace/workspace-preflight'

test('normalizeWorkspacePathInput trims and normalizes absolute paths', () => {
    assert.equal(
        normalizeWorkspacePathInput(' /home/sprite/project// '),
        '/home/sprite/project'
    )
    assert.equal(normalizeWorkspacePathInput('   '), null)
})

test('normalizeWorkspacePathInput rejects relative and NUL paths', () => {
    assert.throws(
        () => normalizeWorkspacePathInput('project'),
        BadRequestException
    )
    assert.throws(
        () => normalizeWorkspacePathInput('/tmp/project\0bad'),
        BadRequestException
    )
})

test('resolveWorkspaceSelection marks custom paths unmanaged', () => {
    assert.deepEqual(resolveWorkspaceSelection(undefined, '/default'), {
        path: '/default',
        managed: true
    })
    assert.deepEqual(resolveWorkspaceSelection('/custom', '/default'), {
        path: '/custom',
        managed: false
    })
})

test('workspace preflight script checks directory existence and writability', () => {
    const script = workspacePreflightScript('/home/sprite/project')

    assert.match(script, /workspace directory does not exist/)
    assert.match(script, /workspace directory is not writable/)
    assert.match(script, /mktemp/)
})

test('assertWorkspaceProbeResult surfaces runtime-side failure message', () => {
    assert.throws(
        () =>
            assertWorkspaceProbeResult('/missing', {
                exitCode: 20,
                stderr: 'workspace directory does not exist: /missing'
            }),
        /workspace directory does not exist/
    )
})

test('isWorkspacePreflightUserError matches every preflight failure message', () => {
    // each branch must be recognizable so daemon-side preflight failures
    // surface as 4xx in attachers — otherwise they hit HttpExceptionFilter
    // as `unhandled` and pollute prod ERROR logs with stack traces
    assert.equal(
        isWorkspacePreflightUserError(
            'workspace directory does not exist: /User/foo/bar'
        ),
        true
    )
    assert.equal(
        isWorkspacePreflightUserError(
            'workspace path is not a directory: /tmp/x'
        ),
        true
    )
    assert.equal(
        isWorkspacePreflightUserError(
            'workspace directory is not readable: /a'
        ),
        true
    )
    assert.equal(
        isWorkspacePreflightUserError(
            'workspace directory is not writable: /a'
        ),
        true
    )
    assert.equal(
        isWorkspacePreflightUserError(
            'workspace directory is not enterable: /a'
        ),
        true
    )
})

test('isWorkspacePreflightUserError does not swallow infra failures', () => {
    // these are server-side problems (offline daemon, broker timeout) and
    // must remain 5xx so on-call still sees them in error metrics
    assert.equal(
        isWorkspacePreflightUserError('daemon abc is offline; no active websocket'),
        false
    )
    assert.equal(
        isWorkspacePreflightUserError('rpc workspace.ensure timed out'),
        false
    )
    assert.equal(isWorkspacePreflightUserError('rpc failed'), false)
})
