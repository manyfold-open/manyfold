import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, delimiter, dirname } from 'node:path'
import type { DetectedFramework } from '@manyfold/shared'
import { resolveBinariesViaLoginShell } from './login-shell-path'

const BINARY_FOR_FRAMEWORK: Record<DetectedFramework['framework'], string> = {
    'claude-code': 'claude',
    codex: 'codex',
    'gemini-cli': 'gemini',
    openclaw: 'openclaw',
    hermes: 'hermes'
}

const which = async (binary: string): Promise<string | null> => {
    const path = process.env.PATH ?? ''
    for (const dir of path.split(delimiter)) {
        if (!dir) continue
        const candidate = join(dir, binary)
        try {
            await access(candidate)
            return candidate
        } catch {}
    }
    return null
}

// Prepend a dir to the daemon's PATH so a CLI we only found via the login shell
// is also runnable: exec.start spawns agents by bare name and resolves them
// against process.env.PATH, so detecting without this would be a "found but
// won't run" trap.
const ensureDirOnPath = (dir: string): void => {
    const current = process.env.PATH ?? ''
    if (current.split(delimiter).includes(dir)) return
    process.env.PATH = current ? `${dir}${delimiter}${current}` : dir
}

const versionOf = (binPath: string): Promise<string | null> =>
    new Promise((resolve) => {
        const child = spawn(binPath, ['--version'], { stdio: 'pipe' })
        const chunks: Buffer[] = []
        let settled = false
        const finish = (val: string | null): void => {
            if (settled) return
            settled = true
            try {
                child.kill('SIGTERM')
            } catch {}
            resolve(val)
        }
        const timer = setTimeout(() => finish(null), 2000)
        child.stdout.on('data', (b: Buffer) => chunks.push(b))
        child.on('close', () => {
            clearTimeout(timer)
            const out = Buffer.concat(chunks).toString('utf8').trim()
            finish(out || null)
        })
        child.on('error', () => {
            clearTimeout(timer)
            finish(null)
        })
    })

export const detectFrameworks = async (): Promise<DetectedFramework[]> => {
    const frameworks = Object.keys(
        BINARY_FOR_FRAMEWORK
    ) as DetectedFramework['framework'][]
    const pathByBinary = new Map<string, string>()
    const missing: string[] = []
    for (const framework of frameworks) {
        const binary = BINARY_FOR_FRAMEWORK[framework]
        const path = await which(binary)
        if (path) pathByBinary.set(binary, path)
        else missing.push(binary)
    }
    // Anything the daemon's own PATH missed may still be installed via
    // nvm/fnm/volta or the Anthropic native installer — ask the user's login
    // shell (lazily, only on a miss) and make the result runnable too.
    if (missing.length > 0) {
        const resolved = await resolveBinariesViaLoginShell(
            Object.values(BINARY_FOR_FRAMEWORK)
        )
        for (const binary of missing) {
            const path = resolved[binary]
            if (!path) continue
            pathByBinary.set(binary, path)
            ensureDirOnPath(dirname(path))
        }
    }
    const results: DetectedFramework[] = []
    for (const framework of frameworks) {
        const path = pathByBinary.get(BINARY_FOR_FRAMEWORK[framework])
        if (!path) continue
        const version = await versionOf(path)
        results.push({ framework, version, path })
    }
    return results
}
