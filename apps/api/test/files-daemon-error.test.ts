import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadGatewayException,
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
    ServiceUnavailableException
} from '@nestjs/common'
import { DaemonRpcResponseError } from '../src/modules/daemon/daemon-registry.service'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'
import { daemonFilesError } from '../src/modules/agents/files/files-daemon-error'

const caught = (fn: () => never): unknown => {
    try {
        fn()
    } catch (err) {
        return err
    }
    throw new Error('expected daemonFilesError to throw')
}

const codeOf = (err: unknown): string | undefined =>
    (
        (err as { getResponse?: () => unknown }).getResponse?.() as {
            code?: string
        }
    )?.code

const refused = (message: string) =>
    caught(() => daemonFilesError(new DaemonRpcResponseError(message)))

// What the daemon refused about a path is the caller's to fix, each with the
// status that says so; unmapped, all of them surfaced as a 500.
test('what the daemon refused about a path maps to the caller\'s status', () => {
    const missing = refused("ENOENT: no such file or directory, stat '/w/x'")
    assert.ok(missing instanceof NotFoundException)
    assert.equal(codeOf(missing), 'not_found')
    assert.ok(refused("EEXIST: file already exists, mkdir '/w/x'") instanceof ConflictException)
    const outside = refused('path /etc/passwd is outside allowed roots (workspace + framework configs); refusing')
    assert.ok(outside instanceof ForbiddenException)
    assert.equal(codeOf(outside), 'forbidden')
    assert.ok(refused('path is a directory') instanceof BadRequestException)
    assert.ok(refused('upload_integrity_mismatch') instanceof BadRequestException)
})

// A machine that cannot be reached, or whose CLI is too old, is the runtime
// being unavailable to us — not the caller's own problem.
test('an unreachable machine or an unknown failure is the runtime being unavailable', () => {
    const offline = caught(() =>
        daemonFilesError(
            new HostDaemonOfflineError(
                { id: 'sbx_1', kind: 'hosted', name: 'sandbox' } as never,
                'runner_unavailable'
            )
        )
    )
    assert.ok(offline instanceof ServiceUnavailableException)
    assert.equal(codeOf(offline), 'runtime_unavailable')
    const unknown = caught(() => daemonFilesError(new Error('socket hang up')))
    assert.ok(unknown instanceof BadGatewayException)
    assert.equal(codeOf(unknown), 'runtime_unavailable')
})

test('an HttpException passes through unchanged', () => {
    const original = new BadRequestException('already mapped')
    assert.equal(caught(() => daemonFilesError(original)), original)
})

// A sandbox whose CLI is too old can be updated from the CLI or the Update
// Center, so it gets a code that says so instead of the generic
// runtime_unavailable (whose hint was "contact support").
test('a sandbox whose CLI is too old answers SANDBOX_CLI_TOO_OLD with what to update', () => {
    const sandbox = {
        id: 'sbx_1',
        kind: 'hosted',
        name: 'sandbox-002',
        providerRef: { kind: 'sprites', spriteName: 'sbx-1' }
    }
    const tooOld = caught(() =>
        daemonFilesError(
            new HostDaemonOfflineError(
                sandbox as never,
                'runner_cli_too_old',
                undefined,
                {
                    cliVersion: '4.8.0',
                    refusal: {
                        message:
                            'sandbox-002 already runs the latest Manyfold CLI (4.8.0), which does not support this yet',
                        cliVersion: '4.8.0',
                        latestCliVersion: '4.8.0'
                    }
                }
            )
        )
    )
    assert.ok(tooOld instanceof ConflictException)
    assert.deepEqual((tooOld as ConflictException).getResponse(), {
        code: 'SANDBOX_CLI_TOO_OLD',
        message:
            'sandbox-002 already runs the latest Manyfold CLI (4.8.0), which does not support this yet',
        details: {
            hostId: 'sbx_1',
            hostName: 'sandbox-002',
            cliVersion: '4.8.0',
            latestCliVersion: '4.8.0'
        }
    })
    // A cloud computer and the user's own computer are not updated that way.
    const pod = caught(() =>
        daemonFilesError(
            new HostDaemonOfflineError(
                { ...sandbox, providerRef: { kind: 'k8s' } } as never,
                'runner_cli_too_old'
            )
        )
    )
    assert.equal(codeOf(pod), 'runtime_unavailable')
    const local = caught(() =>
        daemonFilesError(
            new HostDaemonOfflineError(
                { id: 'dh_1', kind: 'local', name: 'laptop' } as never,
                'runner_cli_too_old'
            )
        )
    )
    assert.equal(codeOf(local), 'runtime_unavailable')
    assert.equal(
        (local as Error).message,
        'the Manyfold CLI on laptop is too old for this; update it and retry'
    )
})
