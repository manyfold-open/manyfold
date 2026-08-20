import assert from 'node:assert/strict'
import test from 'node:test'
import { K8sPodFilesClient } from '../src/modules/agents/files/k8s-pod-files-client'
import type {
    PodExec,
    PodExecRunResult,
    PodExecStreamRequest
} from '../src/modules/k8s/pod-exec'

interface RecordedCall {
    cmd: string[]
    stdin?: string | Buffer
}

const stubPodExec = (
    handler: (req: PodExecStreamRequest) => PodExecRunResult
): { exec: PodExec; calls: RecordedCall[] } => {
    const calls: RecordedCall[] = []
    const exec = {
        run: async (req: PodExecStreamRequest): Promise<PodExecRunResult> => {
            calls.push({ cmd: req.cmd, stdin: req.stdin })
            return handler(req)
        }
    } as unknown as PodExec
    return { exec, calls }
}

test('K8sPodFilesClient.list parses find -printf output identical to sprite shape', async () => {
    const stdout = [
        'd\t4096\t1714435200.123\t755\t.cache',
        'f\t12\t1714435201.456\t644\thello.txt',
        'l\t7\t1714435202.789\t777\tlink-to-x'
    ].join('\n')
    const { exec, calls } = stubPodExec(() => ({
        exitCode: 0,
        stdout,
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const entries = await client.list('/home/node')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].cmd[0], 'bash')
    assert.match(calls[0].cmd[2], /find '\/home\/node' -mindepth 1 -maxdepth 1/)
    assert.deepEqual(
        entries.map((e) => ({ name: e.name, type: e.type, size: e.size })),
        [
            { name: '.cache', type: 'dir', size: 4096 },
            { name: 'hello.txt', type: 'file', size: 12 },
            { name: 'link-to-x', type: 'symlink', size: 7 }
        ]
    )
})

test('K8sPodFilesClient.read decodes base64 stdout and exposes single-chunk stream', async () => {
    const payload = Buffer.from('hello world', 'utf8')
    const { exec } = stubPodExec(() => ({
        exitCode: 0,
        stdout: payload.toString('base64'),
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const result = await client.read('/home/node/hello.txt')
    assert.ok(result)
    assert.equal(result!.size, payload.byteLength)
    const chunks: Uint8Array[] = []
    for await (const chunk of result!.stream) chunks.push(chunk)
    assert.equal(
        Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
        'hello world'
    )
})

test('K8sPodFilesClient.read returns null when stat exits with sentinel 2', async () => {
    const { exec } = stubPodExec(() => ({
        exitCode: 2,
        stdout: '',
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const result = await client.read('/home/node/missing')
    assert.equal(result, null)
})

test('K8sPodFilesClient.write rejects payloads larger than 5 MB without exec', async () => {
    const { exec, calls } = stubPodExec(() => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const tooBig = Buffer.alloc(5 * 1024 * 1024 + 1)
    await assert.rejects(
        () => client.write('/home/node/big.bin', tooBig),
        /exceeds/
    )
    assert.equal(calls.length, 0)
})

test('K8sPodFilesClient.write pipes base64 over stdin and mkdir-p the parent', async () => {
    const { exec, calls } = stubPodExec(() => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const body = Buffer.from('payload', 'utf8')
    await client.write('/home/node/sub/out.txt', body)
    assert.equal(calls.length, 1)
    assert.match(calls[0].cmd[2], /mkdir -p '\/home\/node\/sub'/)
    assert.match(calls[0].cmd[2], /base64 -d > '\/home\/node\/sub\/out\.txt'/)
    assert.equal(calls[0].stdin, body.toString('base64'))
})

test('K8sPodFilesClient.stat parses GNU stat output and resolves directory kind', async () => {
    const { exec } = stubPodExec(() => ({
        exitCode: 0,
        stdout: 'directory\t4096\t1714435200\t755',
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    const result = await client.stat('/home/node')
    assert.ok(result)
    assert.equal(result!.entry.type, 'dir')
    assert.equal(result!.entry.size, 4096)
    assert.equal(result!.entry.mtime, 1714435200)
    assert.equal(result!.entry.mode, '755')
})

test('K8sPodFilesClient.rm refuses blank or root paths before exec', async () => {
    const { exec, calls } = stubPodExec(() => ({
        exitCode: 0,
        stdout: '',
        stderr: ''
    }))
    const client = new K8sPodFilesClient(exec)
    await assert.rejects(() => client.rm('/', false), /refuses path/)
    await assert.rejects(() => client.rm('   ', true), /refuses path/)
    assert.equal(calls.length, 0)
})
