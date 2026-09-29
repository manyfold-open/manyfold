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
