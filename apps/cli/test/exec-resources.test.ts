import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    rpcHandler,
    daemonActivitySnapshot,
    setDeclaredWorkspaceRoot
} from '../src/daemon/rpc'
import type { RpcContext } from '../src/daemon/ws-client'

const within = <T>(promise: Promise<T>, milliseconds = 10000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('owned exec did not settle')),
                milliseconds
            )
        })
    ]).finally(() => clearTimeout(timer))
}

for (const scenario of [
    'success',
    'failure',
    'stdin-open',
    'nested-worker',
    'exited-parent',
    'spawn-error',
    ...(process.platform === 'win32' ? ['path-precedence'] as const : [])
] as const) {
    test(`exec owner cleans private resources before ACK: ${scenario}`, async () => {
        const base = await mkdtemp(join(tmpdir(), 'mf-exec-resource-test-'))
        const previousConfig = process.env.MF_CONFIG_DIR,
            previousProfile = process.env.MF_PROFILE
        process.env.MF_CONFIG_DIR = join(base, 'config')
        delete process.env.MF_PROFILE
        const workspace = join(base, 'workspace')
        await mkdir(workspace)
        setDeclaredWorkspaceRoot(workspace)
        const unowned = join(base, 'must-survive')
        await mkdir(unowned)
        await writeFile(join(unowned, 'marker'), 'untouched')
        let cancel: (() => void) | undefined
        let received!: (record: { directory: string; pids: number[]; args: string[]; input: string }) => void
        const ready = new Promise<{ directory: string; pids: number[]; args: string[]; input: string }>(
            (resolve) => {
                received = resolve
            }
        )
        let stdout = ''
        const context: RpcContext = {
            refId: `owned-${scenario}`,
            sendEvent: (kind, data) => {
                if (kind !== 'stdout') return
                stdout += data
                if (stdout.includes('\n'))
                    received(JSON.parse(stdout.split('\n')[0]))
            },
            onCancel: (handler) => {
                cancel = handler
            }
        }
        const leaf = join(base, 'leaf.cjs'),
            worker = join(base, 'worker.cjs')
        const selectedBinaryDirectory = join(base, 'selected bin')
        if (scenario === 'path-precedence') {
            await mkdir(selectedBinaryDirectory)
            await copyFile(process.execPath, join(selectedBinaryDirectory, 'cmd.exe'))
        }
        await writeFile(
            leaf,
            `process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)+'\\n'); setInterval(()=>{},1000)`
        )
        await writeFile(
            worker,
            `
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process')
const directory=process.env.MF_EXEC_TEMP_DIR
fs.writeFileSync(path.join(directory,'settings.json'),'{}',{mode:0o600})
const ready=(pids)=>process.stdout.write(JSON.stringify({directory,pids,args:process.argv.slice(4),input:process.argv[2]==='stdin-open'?'':fs.readFileSync(0,'utf8')})+'\\n')
if(process.argv[2]==='nested-worker'||process.argv[2]==='exited-parent'){
 const child=spawn(process.execPath,[process.argv[3]],{stdio:['ignore','pipe','ignore']})
 child.stdout.once('data',(data)=>{ready([process.pid,Number(String(data).trim())]);if(process.argv[2]==='exited-parent'){child.stdout.destroy();child.unref()}})
 if(process.argv[2]==='nested-worker'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
}else{
 ready([process.pid])
 if(process.argv[2]==='stdin-open'){process.on('SIGTERM',()=>{});process.stdin.resume()}
 else process.exitCode=process.argv[2]==='failure'?7:0
}
`
        )
        let running: ReturnType<typeof rpcHandler> | undefined
        try {
            running = rpcHandler(
                'exec.start',
                {
                    cmd:
                        scenario === 'spawn-error'
                            ? [join(base, 'missing-binary')]
                        : [scenario === 'path-precedence' ? 'cmd.exe' : process.execPath, worker, scenario, leaf, 'quoted "argument"', 'trailing\\', '\u4ef7\u683c'],
                    dir: workspace,
                    temporarySettings: 'gemini-platform',
                    keepStdinOpen: scenario === 'stdin-open',
                    stdin: 'fixture \u8f93\u5165',
                    env: { MF_EXEC_TEMP_DIR: unowned, ...(scenario === 'path-precedence' ? { PATH: selectedBinaryDirectory } : {}) },
                    timeoutMs: 15000
                },
                context
            )
            if (scenario === 'spawn-error') {
                assert.equal((await within(running)).ok, false)
            } else {
                const record = await within(ready)
                assert.deepEqual(record.args, ['quoted "argument"', 'trailing\\', '\u4ef7\u683c'])
                if (scenario !== 'stdin-open') assert.equal(record.input, 'fixture \u8f93\u5165')
                assert.notEqual(record.directory, unowned)
                if (scenario === 'stdin-open' || scenario === 'nested-worker') {
                    assert.ok(cancel)
                    assert.equal(daemonActivitySnapshot().activeExecs, 1)
                    cancel()
                }
                const result = await within(running)
                assert.equal(
                    result.ok,
                    scenario === 'success' || scenario === 'failure' || scenario === 'exited-parent' || scenario === 'path-precedence'
                )
                if (scenario === 'failure')
                    assert.equal(result.payload?.exitCode, 7)
                await assert.rejects(stat(record.directory), { code: 'ENOENT' }, JSON.stringify(result))
                for (const pid of record.pids) {
                    assert.notEqual(pid, process.pid)
                    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
                }
            }
            assert.equal(daemonActivitySnapshot().activeExecs, 0)
            assert.equal(
                await readFile(join(unowned, 'marker'), 'utf8'),
                'untouched'
            )
        } finally {
            cancel?.()
            if (running) await within(running).catch(() => {})
            setDeclaredWorkspaceRoot(null)
            if (previousConfig === undefined) delete process.env.MF_CONFIG_DIR
            else process.env.MF_CONFIG_DIR = previousConfig
            if (previousProfile === undefined) delete process.env.MF_PROFILE
            else process.env.MF_PROFILE = previousProfile
            await rm(base, { recursive: true, force: true })
        }
    })
}
