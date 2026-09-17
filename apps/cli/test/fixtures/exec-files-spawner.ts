// Starts one file exec and exits without waiting for it, standing in for a
// daemon that died mid-turn. The parent test adopts what it left behind.
import { ExecStream, execStreams } from '../../src/daemon/exec-buffer'
import { startFileExec } from '../../src/daemon/exec-files'

const refId = process.argv[2]
const cmd = JSON.parse(process.argv[3]) as string[]
const stream = new ExecStream({ refId, method: 'exec.start', payload: { cmd } })
execStreams.set(refId, stream)
const handle = startFileExec({
    refId,
    cmd,
    cwd: process.cwd(),
    env: process.env,
    stdin: '',
    stream,
    log: () => {}
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
