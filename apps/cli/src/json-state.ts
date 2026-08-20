import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export const readJsonState = async (
    filePath: string
): Promise<unknown | undefined> => {
    let raw: string
    try {
        raw = await readFile(filePath, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        const code = (err as NodeJS.ErrnoException).code ?? 'I/O error'
        throw new Error(`could not read ${filePath} (${code})`)
    }
    try {
        return JSON.parse(raw) as unknown
    } catch {
        throw new Error(`invalid JSON in ${filePath}`)
    }
}

export const writeProtectedFile = async (
    filePath: string,
    text: string
): Promise<void> => {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})

    const tmpPath = `${filePath}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        handle = await open(tmpPath, 'wx', 0o600)
        try {
            await handle.writeFile(text, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
            handle = undefined
        }
        await chmod(tmpPath, 0o600).catch(() => {})
        await rename(tmpPath, filePath)
    } catch (err) {
        await handle?.close().catch(() => {})
        await unlink(tmpPath).catch(() => {})
        throw err
    }
}

export const writeProtectedJson = async (
    filePath: string,
    value: unknown
): Promise<void> => writeProtectedFile(filePath, JSON.stringify(value, null, 2))
