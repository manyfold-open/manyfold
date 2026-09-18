// Starts one file exec and exits without waiting for it, standing in for a
// daemon that died mid-turn. The parent test adopts what it left behind.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ExecStream, execStreams } from '../../src/daemon/exec-buffer'
import { startFileExec } from '../../src/daemon/exec-files'

const refId = process.argv[2]
const cmd = JSON.parse(process.argv[3]) as string[]
// Optional: { lockDir } takes a profile lease under this process's pid the
// way the daemon would, so the parent can watch the adopter re-stamp it.
const opts = JSON.parse(process.argv[5] ?? '{}') as { lockDir?: string }
if (opts.lockDir) {
    mkdirSync(opts.lockDir, { recursive: true, mode: 0o700 })
    writeFileSync(
        join(opts.lockDir, 'owner.json'),
        JSON.stringify({
            pid: process.pid,
            label: `exec:${refId}`,
            acquiredAt: new Date().toISOString()
        })
    )
}
const stream = new ExecStream({ refId, method: 'exec.start', payload: { cmd } })
execStreams.set(refId, stream)
const handle = startFileExec({
    refId,
    cmd,
    cwd: process.cwd(),
    env: process.env,
    stdin: '',
    stream,
    log: () => {},
    auth: opts.lockDir
        ? {
              lockDir: opts.lockDir,
              label: `exec:${refId}`,
              release: async () =>
                  rmSync(opts.lockDir!, { recursive: true, force: true })
          }
        : undefined
})
// Let the first poll publish whatever the child wrote already, so the
// adoption has events (and offsets) to continue from.
setTimeout(
    () => {
        process.stdout.write(
            `${JSON.stringify({ refId, seq: stream.seq, cancelled: handle.cancelled })}\n`
        )
        process.exit(0)
    },
    Number(process.argv[4] ?? 400)
)
