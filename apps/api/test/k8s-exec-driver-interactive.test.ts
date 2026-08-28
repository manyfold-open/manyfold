import assert from 'node:assert/strict'
import test from 'node:test'
import { K8sExecDriver } from '../src/modules/chat/adapters/k8s-exec-driver'
import type {
    PodExecInteractiveHandle,
    PodExecInteractiveRequest
} from '../src/modules/k8s/pod-exec'

test('streamInteractive wraps the command and forwards stdin control', async () => {
    const requests: PodExecInteractiveRequest[] = []
    const writes: Buffer[] = []
    let ended = false
    let aborted = false
    const handle: PodExecInteractiveHandle = {
        stdout: (async function* () {})(),
        stderr: (async function* () {})(),
        stdin: {
            write: (data) =>
                writes.push(
                    Buffer.isBuffer(data) ? data : Buffer.from(data)
                ),
            end: () => {
                ended = true
            }
        },
        result: Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
        abort: () => {
            aborted = true
        }
    }
    const podExec = {
        streamInteractive: (req: PodExecInteractiveRequest) => {
            requests.push(req)
            return handle
        }
    }
    const driver = new K8sExecDriver(podExec as never)
    const interactive = driver.streamInteractive({
        cmd: ['hermes', 'acp', '--accept-hooks'],
        env: { HERMES_YOLO_MODE: '1', OPENROUTER_API_KEY: 'sk-x' },
        dir: '/home/node/work',
        timeoutMs: 10_000
    })

    assert.equal(requests.length, 1)
    const [req] = requests
    assert.equal(req.timeoutMs, 15_000)
    assert.deepEqual(req.cmd.slice(0, 2), ['bash', '-c'])
    const script = req.cmd[2]
    assert.match(script, /^cd '\/home\/node\/work' && /)
    assert.match(script, /export HERMES_YOLO_MODE='1'/)
    assert.match(script, /export OPENROUTER_API_KEY='sk-x'/)
    assert.match(script, /timeout 10s 'hermes' 'acp' '--accept-hooks'$/)

    interactive.write(Buffer.from('frame\n'))
    assert.equal(Buffer.concat(writes).toString('utf8'), 'frame\n')
    interactive.endInput()
    assert.equal(ended, true)
    interactive.abort()
    assert.equal(aborted, true)
    assert.deepEqual(await interactive.result, {
        exitCode: 0,
        stdout: '',
        stderr: ''
    })
})
