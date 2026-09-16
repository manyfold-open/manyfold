import { claimDaemonPid, DaemonAlreadyRunningError } from '../../src/daemon/pid'

const pidPath = process.argv[2]
if (!pidPath) throw new Error('isolated PID path required')
let ownership: Awaited<ReturnType<typeof claimDaemonPid>> | undefined
let started = false
process.on('message', (message) => {
    void (async () => {
        if (message === 'claim' && !started) {
            started = true
            try {
                ownership = await claimDaemonPid(process.pid, { pidPath })
                process.send?.({ kind: 'acquired', pid: process.pid })
            } catch (err) {
                if (!(err instanceof DaemonAlreadyRunningError)) throw err
                process.send?.({
                    kind: 'busy',
                    pid: process.pid,
                    ownerPid: err.pid
                })
                process.disconnect()
            }
        } else if (message === 'release' && ownership) {
            await ownership.release()
            process.send?.({ kind: 'released', pid: process.pid })
            process.disconnect()
        }
    })().catch((err: Error) => {
        process.send?.({ kind: 'error', message: err.message })
        process.exitCode = 1
        process.disconnect()
    })
})
if (process.send) process.send({ kind: 'ready', pid: process.pid })
else
    void (async () => {
        try {
            ownership = await claimDaemonPid(process.pid, { pidPath })
            console.log(
                JSON.stringify({
                    kind: 'acquired',
                    pid: process.pid,
                    instanceId: ownership.instanceId
                })
            )
            if (process.argv[3] === 'once') {
                await ownership.release()
                console.log(
                    JSON.stringify({ kind: 'released', pid: process.pid })
                )
                return
            }
            const timer = setInterval(() => {}, 1000)
            process.once('SIGTERM', () => {
                void ownership!.release().then(() => {
                    clearInterval(timer)
                    process.exit(0)
                })
            })
        } catch (err) {
            if (err instanceof DaemonAlreadyRunningError) {
                console.log(JSON.stringify({ kind: 'busy', ownerPid: err.pid }))
                process.exitCode = 2
            } else {
                console.error((err as Error).message)
                process.exitCode = 1
            }
        }
    })()
