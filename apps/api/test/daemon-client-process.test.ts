import assert from 'node:assert/strict'
import test from 'node:test'
import {
    daemonClientProcessFields,
    parseDaemonClientProcess
} from '../src/modules/daemon/daemon-client-process'

test('daemon process metadata is optional and bounded before it reaches logs', () => {
    const value = {
        instanceId: 'A20627B1-3FAF-43A3-9609-7FACD812E040',
        pid: 1234
    }
    assert.deepEqual(parseDaemonClientProcess(value), {
        instanceId: value.instanceId.toLowerCase(),
        pid: 1234
    })
    for (const invalid of [
        undefined,
        null,
        [],
        'bad',
        {},
        { ...value, instanceId: 'line\nforged=true' },
        { ...value, instanceId: 'a'.repeat(10000) },
        { ...value, pid: '1234' },
        { ...value, pid: 0 },
        { ...value, pid: -1 },
        { ...value, pid: 1.5 },
        { ...value, pid: 2147483648 }
    ]) {
        const parsed = parseDaemonClientProcess(invalid)
        assert.equal(parsed, undefined)
        assert.equal(
            daemonClientProcessFields(parsed),
            'clientInstanceId=unknown clientPid=unknown'
        )
    }
})
