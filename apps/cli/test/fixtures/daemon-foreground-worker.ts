import { buildProgram } from '../../src/program'

if (!process.send) throw new Error('foreground fixture requires IPC')
process.once('message', () => {
    void buildProgram()
        .parseAsync(['node', 'mf', 'daemon', 'start', '--foreground'])
        .catch((err: Error) => {
            console.error(err.message)
            process.exit(1)
        })
})
process.send({ kind: 'ready' })
